import type RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { assertPhysicsReady } from '../physics/initPhysics';
import { createRayHit, PhysicsWorld } from '../physics/PhysicsWorld';
import { Vehicle } from '../physics/Vehicle';
import { DEG, sanitizeInput } from '../physics/util';
import { createAirState, createSnapshot } from '../snapshot';
import { ZoneTester } from '../track/zones';
import { TUNING } from '../tuning';
import type {
  CrashReason,
  GameEvent,
  InputState,
  LandingResult,
  LevelDef,
  SimSnapshot,
  TrickInstance,
} from '../types';
import { VEHICLE } from '../vehicleSpec';
import { CrashDetector } from './CrashDetector';
import { classifyLanding, landingRank, measureTouchdown, type TouchdownSample } from './LandingEvaluator';
import { ObjectiveRunner } from './Objectives';
import { buildLevelResult, chainMultiplier, comboMultiplier, jumpBasePoints, ScoreKeeper, scoreJump } from './Scoring';
import { TrajectoryPredictor } from './TrajectoryPredictor';
import { TrickTracker } from './TrickTracker';

export interface GameSimOptions {
  /** First attempt of this level in the session (tutorial slow-mo prompts only play once). Default true. */
  firstAttempt?: boolean;
  /** Weak automatic leveling in the air when no rotation input is held. Default true. */
  flightAssist?: boolean;
}

export interface Pose {
  position: Vector3;
  quaternion: Quaternion;
}

/** Jump lifecycle: ground → air (< 0.25 s, unscored hop) → jump → touchdown window → settle → ground. */
type JumpPhase = 'ground' | 'air' | 'jump' | 'touchdown' | 'settle';

const WORLD_UP = new Vector3(0, 1, 0);
const DOWN = new Vector3(0, -1, 0);
const RIDE_HEIGHT = -VEHICLE.groundY;

const _v = new Vector3();
const _q = new Quaternion();
const _local = new Vector3();

/**
 * Headless game simulation (pure TS + Rapier): one fixed tick of TUNING.dt per `step()`.
 *
 * Usage:
 * ```ts
 * await initPhysics();
 * const sim = new GameSim(level, { firstAttempt: true, flightAssist: true });
 * sim.step(input);                 // fixed 120 Hz
 * sim.snapshot / sim.prevPose / sim.currPose / sim.drainEvents()
 * sim.reset();                     // fresh deterministic world, emits 'reset'
 * sim.dispose();
 * ```
 * The sim requests slow motion through `snapshot.timeScale` (crash, PERFECT landing, tutorial
 * prompts) but never scales its own dt — the runner scales real time.
 */
export class GameSim {
  readonly level: LevelDef;
  /** Current state, mutated in place every tick (stable object across resets). */
  readonly snapshot: SimSnapshot;
  readonly prevPose: Pose = { position: new Vector3(), quaternion: new Quaternion() };
  readonly currPose: Pose = { position: new Vector3(), quaternion: new Quaternion() };
  /** Physics world wrapper (exposed for debugging / tools). */
  physics!: PhysicsWorld;
  /** Vehicle (exposed for debugging / tools). */
  vehicle!: Vehicle;

  private readonly opts: { firstAttempt: boolean; flightAssist: boolean };
  private readonly events: GameEvent[] = [];
  private readonly tickEvents: GameEvent[] = [];
  private readonly objectiveEvents: GameEvent[] = [];
  /** Zone testers in level order (array: no per-tick iterator allocation) + inside flags. */
  private readonly zoneTesters: ZoneTester[] = [];
  private readonly zoneInside: boolean[] = [];
  private readonly zoneIndex = new Map<string, number>();
  private readonly targetZone: ZoneTester | null;
  private readonly finishZone: ZoneTester | null;
  private readonly tricks = new TrickTracker();
  private readonly scoring: ScoreKeeper;
  private readonly objectives: ObjectiveRunner;
  private readonly predictor = new TrajectoryPredictor();
  private readonly crash = new CrashDetector();
  private readonly input: InputState = { throttle: 0, steer: 0, roll: 0, boost: false, vacuum: false, stabilize: false };
  private readonly heightHit = createRayHit();
  private readonly inZoneFn = (id: string): boolean => {
    const i = this.zoneIndex.get(id);
    return i !== undefined && this.zoneInside[i];
  };

  // jump state
  private jumpPhase: JumpPhase = 'ground';
  private airStart = 0;
  private readonly takeoffPos = new Vector3();
  private takeoffSpeed = 0;
  private maxHeight = 0;
  private readonly lastAirVelocity = new Vector3();
  private touchdownTime = 0;
  private readonly touchdownPos = new Vector3();
  private readonly touchdownNormal = new Vector3(0, 1, 0);
  private touchdown: TouchdownSample | null = null;
  private touchdownAirTime = 0;
  private touchdownDistance = 0;
  private wheelMask = 0;
  private chassisHit = false;
  private landing: LandingResult | null = null;
  private settleAir = 0;

  // inverted bonus
  private invertedRun = 0;
  private invertedCarry: TrickInstance | null = null;
  private invertedCarryTime = 0;

  // finish & time scale
  /**
   * A qualifying landing in the finish zone, promoted to `pendingFinish` after this tick's objectives
   * ran (the same landing may complete the last objective before the finish).
   */
  private finishCandidate: { landing: LandingResult; start: number } | null = null;
  private pendingFinish: { landing: LandingResult; start: number } | null = null;
  private crashSlowUntil = -1;
  private perfectSlowUntil = -1;
  private predicting = false;
  private disposed = false;

  constructor(level: LevelDef, opts: GameSimOptions = {}) {
    assertPhysicsReady('GameSim');
    this.level = level;
    this.opts = { firstAttempt: opts.firstAttempt ?? true, flightAssist: opts.flightAssist ?? true };
    this.snapshot = createSnapshot(level.id);
    for (const z of level.zones) {
      this.zoneIndex.set(z.id, this.zoneTesters.length);
      this.zoneTesters.push(new ZoneTester(z));
      this.zoneInside.push(false);
    }
    this.targetZone = this.zoneById(level.targetZoneId);
    this.finishZone = this.zoneById(level.finish.zoneId);
    this.scoring = new ScoreKeeper(this.snapshot.score);
    this.objectives = new ObjectiveRunner(level, this.opts.firstAttempt, this.snapshot.objective);
    this.build(false);
  }

  /** The Rapier world (debugging). */
  get world(): RAPIER.World {
    return this.physics.world;
  }

  get time(): number {
    return this.snapshot.time;
  }

  private zoneById(id: string | undefined): ZoneTester | null {
    const i = id === undefined ? undefined : this.zoneIndex.get(id);
    return i === undefined ? null : this.zoneTesters[i];
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  /** Restarts the level: fresh Rapier world, spawn pose, cleared run state. Emits 'reset'. */
  reset(): void {
    if (this.disposed) return;
    this.build(true);
  }

  setOptions(opts: { flightAssist?: boolean; firstAttempt?: boolean }): void {
    if (opts.flightAssist !== undefined) {
      this.opts.flightAssist = opts.flightAssist;
      this.vehicle.setOptions({ flightAssist: opts.flightAssist });
    }
    if (opts.firstAttempt !== undefined) {
      this.opts.firstAttempt = opts.firstAttempt;
      this.objectives.setFirstAttempt(opts.firstAttempt);
    }
  }

  /** Events emitted since the last drain (oldest first). */
  drainEvents(): GameEvent[] {
    if (this.events.length === 0) return [];
    const out = this.events.slice();
    this.events.length = 0;
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.vehicle?.dispose();
    this.physics?.dispose();
  }

  /**
   * Teleports the car (tests, debug tools). Resets the jump state machine so the placement is
   * not scored as a jump unless the car then genuinely flies.
   */
  placeVehicle(position: Vector3, quaternion: Quaternion, velocity?: Vector3, angularVelocity?: Vector3): void {
    if (this.disposed) return;
    this.vehicle.teleport(position, quaternion, velocity, angularVelocity);
    this.jumpPhase = 'ground';
    this.tricks.reset();
    this.crash.reset(); // no stale contact / rollover timers from the previous pose
    this.vehicle.airTime = 0;
    this.prevPose.position.copy(position);
    this.prevPose.quaternion.copy(quaternion);
    this.currPose.position.copy(position);
    this.currPose.quaternion.copy(quaternion);
  }

  private build(emitReset: boolean): void {
    this.physics?.dispose();
    const level = this.level;
    this.physics = new PhysicsWorld(level);
    const spawn = this.spawnPose();
    this.vehicle = new Vehicle(
      this.physics,
      { position: spawn.position, quaternion: spawn.quaternion, speed: level.spawn.speed ?? 0 },
      { fuel: level.fuel, vacuumEnabled: level.vacuumEnabled, flightAssist: this.opts.flightAssist },
      this.snapshot.vehicle,
    );

    const s = this.snapshot;
    s.tick = 0;
    s.time = 0;
    s.phase = 'ready';
    s.levelId = level.id;
    Object.assign(s.air, createAirState());
    s.air.tricks = this.tricks.tricks;
    s.air.rotation = this.tricks.rotation;
    s.prediction = null;
    s.prompt = null;
    s.timeScale = 1;
    s.crashReason = null;
    s.result = null;
    this.scoring.reset();
    this.tricks.reset();
    this.crash.reset();
    this.predictor.reset();
    this.jumpPhase = 'ground';
    this.landing = null;
    this.touchdown = null;
    this.finishCandidate = null;
    this.pendingFinish = null;
    this.invertedRun = 0;
    this.invertedCarry = null;
    this.crashSlowUntil = -1;
    this.perfectSlowUntil = -1;
    this.predicting = false;
    this.lastAirVelocity.copy(this.vehicle.state.velocity);
    for (let i = 0; i < this.zoneTesters.length; i++) this.zoneInside[i] = this.zoneTesters[i].contains(this.vehicle.state.position);

    this.prevPose.position.copy(spawn.position);
    this.prevPose.quaternion.copy(spawn.quaternion);
    this.currPose.position.copy(spawn.position);
    this.currPose.quaternion.copy(spawn.quaternion);

    this.events.length = 0;
    if (emitReset) this.events.push({ type: 'reset' });
    this.objectives.reset(this.opts.firstAttempt, 0, this.events);
  }

  /** Spawn pose: yaw from the level, snapped onto the surface below when one is within reach. */
  private spawnPose(): Pose {
    const sp = this.level.spawn;
    const position = new Vector3(sp.position[0], sp.position[1], sp.position[2]);
    const quaternion = new Quaternion().setFromAxisAngle(WORLD_UP, sp.yawDeg * DEG);
    // Accept either the chassis origin or the ground point as spawn height.
    _v.copy(position).addScaledVector(WORLD_UP, 0.5);
    const hit = this.physics.raycast(_v, DOWN, 1.6, this.heightHit);
    if (hit && hit.normal.y > 0.7) {
      _q.setFromUnitVectors(WORLD_UP, hit.normal);
      quaternion.premultiply(_q);
      position.copy(hit.point).addScaledVector(hit.normal, RIDE_HEIGHT);
    }
    return { position, quaternion };
  }

  /* ---------------------------------------------------------------- */
  /* Tick                                                              */
  /* ---------------------------------------------------------------- */

  /** Advances the simulation by one fixed tick (TUNING.dt). */
  step(input: Readonly<InputState>): void {
    if (this.disposed) return;
    const dt = TUNING.dt;
    const s = this.snapshot;
    if (s.phase === 'ready') s.phase = 'running';
    const inp = sanitizeInput(input, this.input);
    this.tickEvents.length = 0;

    this.prevPose.position.copy(this.currPose.position);
    this.prevPose.quaternion.copy(this.currPose.quaternion);

    // --- physics ----------------------------------------------------------
    const pred = this.predictor.prediction;
    this.vehicle.preStep({ input: inp, stabilizeNormal: this.predicting && pred.valid ? pred.normal : null }, this.tickEvents);
    this.physics.step();
    this.vehicle.postStep();
    s.tick++;
    s.time += dt;
    const st = this.vehicle.state;

    // --- gameplay ------------------------------------------------------------
    if (s.phase === 'running') this.updateJump(dt);
    // The detector also emits the chassis `impact` events, so it keeps running after a crash (the
    // tumbling wreck throws sparks) and after the finish; its verdicts only count while running.
    const verdict = this.crash.update(
      {
        vehicle: this.vehicle,
        killY: this.level.killY,
        dt,
        landing: this.jumpPhase === 'touchdown' || this.jumpPhase === 'settle',
        inJump: this.jumpPhase === 'air' || this.jumpPhase === 'jump' || this.jumpPhase === 'touchdown',
      },
      this.tickEvents,
    );
    if (verdict && s.phase === 'running') this.triggerCrash(verdict.reason, verdict.impactSpeed, verdict.position);
    if (s.phase === 'running') this.updateInverted(dt);
    this.updateZones();
    this.updatePrediction();
    this.updateAirState();
    this.scoring.trackSpeed(st.speed);

    if (s.phase === 'running') {
      this.objectiveEvents.length = 0;
      this.objectives.update(s, inp, this.tickEvents, this.inZoneFn, s.time, this.objectiveEvents);
      for (const e of this.objectiveEvents) this.tickEvents.push(e);
      this.updateFinish();
    }
    s.prompt = s.phase === 'running' ? this.objectives.currentPrompt : null;
    this.updateTimeScale();

    this.currPose.position.copy(st.position);
    this.currPose.quaternion.copy(st.quaternion);
    for (const e of this.tickEvents) this.events.push(e);
  }

  /* ---------------------------------------------------------------- */
  /* Jump lifecycle, landing, tricks                                   */
  /* ---------------------------------------------------------------- */

  private updateJump(dt: number): void {
    const v = this.vehicle;
    const st = v.state;
    const time = this.snapshot.time;
    // real chassis touches end a jump; any (speculative) contact freezes the pre-contact velocity
    const contacts = v.touchingCount > 0;
    if (st.groundedWheels === 0 && v.contactCount === 0) this.lastAirVelocity.copy(st.velocity);

    switch (this.jumpPhase) {
      case 'ground':
        if (st.airborne) this.beginAir();
        break;

      case 'air':
        if (!st.airborne || contacts) {
          // sub-threshold hop: not scored
          this.jumpPhase = 'ground';
          this.tricks.reset();
          break;
        }
        this.integrateTricks(dt);
        if (time - this.airStart >= TUNING.air.jumpMinAirTime) {
          this.jumpPhase = 'jump';
          this.tickEvents.push({ type: 'takeoff', position: this.takeoffPos.clone(), speed: this.takeoffSpeed });
          this.snapshot.score.jumps++;
          if (this.invertedCarry) {
            this.tricks.adopt(this.invertedCarry);
            this.invertedCarry = null;
          }
        }
        break;

      case 'jump':
        this.integrateTricks(dt);
        if (st.groundedWheels >= 2 || contacts) this.beginTouchdown();
        break;

      case 'touchdown':
        this.wheelMask |= this.groundedMask();
        if (contacts) this.chassisHit = true;
        if (time - this.touchdownTime >= TUNING.landing.touchdownWindow - 1e-9) this.evaluateLanding();
        break;

      case 'settle':
        if (st.airborne) {
          this.settleAir += dt;
          // left the platform: nothing below ⇒ the landing becomes a crash right away
          if (!this.physics.raycast(st.position, DOWN, 80, this.heightHit)) {
            this.triggerCrash('missed-platform', st.speed, st.position.clone());
            break;
          }
          if (this.settleAir > TUNING.air.jumpMinAirTime) {
            // bounced / launched onto more track: close this landing, the new flight is a jump
            this.endSettle();
            this.beginAir();
            break;
          }
        } else {
          this.settleAir = 0;
        }
        if (time - this.touchdownTime >= TUNING.landing.settleTime) this.endSettle();
        break;
    }
  }

  private beginAir(): void {
    const st = this.vehicle.state;
    this.jumpPhase = 'air';
    this.airStart = this.snapshot.time - this.vehicle.airTime;
    this.takeoffPos.copy(st.position);
    this.takeoffSpeed = st.speed;
    this.maxHeight = 0;
    this.tricks.reset();
  }

  private integrateTricks(dt: number): void {
    const st = this.vehicle.state;
    this.vehicle.body.toLocal(st.angularVelocity, _local);
    this.tricks.update(_local, dt, this.snapshot.time - this.airStart, this.tickEvents);
    this.maxHeight = Math.max(this.maxHeight, st.position.y - this.takeoffPos.y);
  }

  private groundedMask(): number {
    let m = 0;
    const wheels = this.vehicle.state.wheels;
    for (let i = 0; i < 4; i++) if (wheels[i].grounded) m |= 1 << i;
    return m;
  }

  private beginTouchdown(): void {
    const v = this.vehicle;
    const st = v.state;
    const time = this.snapshot.time;
    this.jumpPhase = 'touchdown';
    this.touchdownTime = time;
    this.touchdownPos.copy(st.position);
    if (st.groundedWheels > 0) this.touchdownNormal.copy(v.groundNormal);
    else {
      this.touchdownNormal.set(0, 0, 0);
      for (let i = 0; i < v.contactCount; i++) if (v.contacts[i].touching) this.touchdownNormal.add(v.contacts[i].normal);
      if (this.touchdownNormal.lengthSq() < 1e-8) this.touchdownNormal.copy(WORLD_UP);
      this.touchdownNormal.normalize();
    }
    this.touchdownAirTime = time - this.airStart;
    _v.subVectors(st.position, this.takeoffPos);
    this.touchdownDistance = Math.hypot(_v.x, _v.z);
    this.wheelMask = this.groundedMask();
    this.chassisHit = v.touchingCount > 0;
    this.touchdown = measureTouchdown(st.up, st.forward, this.lastAirVelocity, this.touchdownNormal, 0, this.chassisHit);
    this.tricks.finalize(this.touchdownAirTime, this.tickEvents);
  }

  private evaluateLanding(): void {
    const sample = this.touchdown!;
    let mask = this.wheelMask;
    let wheels = 0;
    while (mask) {
      wheels += mask & 1;
      mask >>= 1;
    }
    sample.wheelsDown = wheels;
    sample.chassisHit = this.chassisHit;
    const quality = classifyLanding(sample);
    const time = this.snapshot.time;

    let inTarget = false;
    if (this.targetZone) {
      inTarget = this.targetZone.contains(this.touchdownPos, 0.5);
      if (inTarget && quality !== 'crash' && this.targetZone.radial(this.touchdownPos) <= TUNING.scoring.bullseyeRadius) {
        this.tricks.addBonus('bullseye', 'BULLSEYE', 1, TUNING.scoring.bullseye, this.tickEvents);
      }
    }
    const chain = this.scoring.chainFor(quality, time);
    const js = scoreJump(quality, this.touchdownAirTime, this.touchdownDistance, this.tricks.tricks, chain);
    const result: LandingResult = {
      quality,
      angleDeg: sample.angleDeg,
      impactSpeed: sample.impactSpeed,
      driftDeg: sample.driftDeg,
      wheelsDown: sample.wheelsDown,
      airTime: this.touchdownAirTime,
      distance: this.touchdownDistance,
      maxHeight: this.maxHeight,
      tricks: this.tricks.tricks.map((t) => ({ ...t })),
      basePoints: js.base,
      multiplier: js.multiplier,
      points: js.points,
      inTarget,
      position: this.touchdownPos.clone(),
    };
    this.landing = result;
    this.tickEvents.push({ type: 'landing', result });
    this.scoring.addLanding(result, time, chain);
    this.tricks.reset();
    this.jumpPhase = 'settle';
    this.settleAir = 0;

    if (quality === 'crash') {
      this.triggerCrash('hard-impact', sample.impactSpeed, this.touchdownPos.clone());
      return;
    }
    if (quality === 'perfect') this.perfectSlowUntil = time + TUNING.perfectSlowMo.duration;
    const fin = this.level.finish;
    if (this.finishZone && this.finishZone.contains(this.touchdownPos, 0.5) && landingRank(quality) >= landingRank(fin.minQuality)) {
      // readiness is checked in updateFinish(), after this tick's objectives saw the landing event
      this.finishCandidate = { landing: result, start: this.touchdownTime };
    }
  }

  private endSettle(): void {
    this.jumpPhase = 'ground';
    this.landing = null;
    this.touchdown = null;
  }

  private triggerCrash(reason: CrashReason, impactSpeed: number, position: Vector3): void {
    const s = this.snapshot;
    if (s.phase !== 'running') return;
    s.phase = 'crashed';
    s.crashReason = reason;
    this.vehicle.crashed = true;
    this.vehicle.state.crashed = true;
    // a landing still settling is downgraded and its points revoked
    if (this.jumpPhase === 'settle' && this.landing && this.landing.quality !== 'crash') this.scoring.revokeLanding(this.landing);
    this.scoring.onCrash();
    this.tickEvents.push({ type: 'crash', reason, position, impactSpeed });
    this.crashSlowUntil = s.time + TUNING.crash.slowMoTime;
    this.finishCandidate = null;
    this.pendingFinish = null;
    this.invertedCarry = null;
    this.invertedRun = 0;
    this.tricks.reset();
    this.jumpPhase = 'ground';
    this.landing = null;
  }

  /* ---------------------------------------------------------------- */
  /* Inverted bonus                                                    */
  /* ---------------------------------------------------------------- */

  private updateInverted(dt: number): void {
    const st = this.vehicle.state;
    const time = this.snapshot.time;
    const inverted = st.groundedWheels >= 3 && st.vacuum.mode === 'engaged' && st.up.y < -0.5;
    if (inverted) {
      const d = st.speed * dt;
      this.invertedRun += d;
      this.snapshot.score.invertedDistance += d;
    } else if (this.invertedRun > 0) {
      const sc = TUNING.scoring;
      if (this.invertedRun >= sc.invertedMinDistance) {
        const meters = Math.round(this.invertedRun);
        const trick: TrickInstance = {
          kind: 'inverted',
          label: `INVERTED ${meters} m`,
          count: 1,
          points: Math.round(this.invertedRun * sc.invertedPerMeter),
        };
        this.tickEvents.push({ type: 'trick', trick: { ...trick } });
        this.invertedCarry = trick;
        this.invertedCarryTime = time;
      }
      this.invertedRun = 0;
    }
    // not followed by a jump: bank it directly
    if (this.invertedCarry && this.jumpPhase === 'ground' && time - this.invertedCarryTime > 2.5) {
      this.scoring.addBonus(this.invertedCarry.points);
      this.snapshot.score.tricks++;
      this.invertedCarry = null;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Zones, prediction, air state, finish, time scale                  */
  /* ---------------------------------------------------------------- */

  private updateZones(): void {
    const p = this.vehicle.state.position;
    for (let i = 0; i < this.zoneTesters.length; i++) {
      const tester = this.zoneTesters[i];
      const inside = tester.contains(p);
      if (inside && !this.zoneInside[i]) {
        const id = tester.zone.id;
        this.tickEvents.push({ type: 'zoneEnter', id });
        if (tester.zone.purpose === 'checkpoint') this.tickEvents.push({ type: 'checkpoint', id });
      }
      this.zoneInside[i] = inside;
    }
  }

  private updatePrediction(): void {
    const s = this.snapshot;
    const st = this.vehicle.state;
    // While hanging from a ceiling on the vacuum (the release section), show where a release would land.
    // Not on walls / quarter pipes: the ballistic path re-intersects the curved surface right ahead.
    const onCeiling = st.vacuum.mode === 'engaged' && st.groundedWheels > 0 && this.vehicle.groundNormal.y < -0.5;
    // in the air: also during the 0.08 s airborne debounce, so the arc never flickers after a release
    const inAir = st.groundedWheels === 0 && this.vehicle.touchingCount === 0;
    const want = s.phase !== 'crashed' && (inAir || this.jumpPhase === 'air' || this.jumpPhase === 'jump' || onCeiling);
    if (!want) {
      if (this.predicting) this.predictor.reset();
      this.predicting = false;
      s.prediction = null;
      return;
    }
    if (!this.predicting || s.tick % TUNING.prediction.interval === 0) {
      this.predictor.predict(this.physics, st.position, st.velocity, this.targetZone);
    }
    this.predicting = true;
    this.predictor.updateAttitude(st.up, st.forward, st.right);
    s.prediction = this.predictor.prediction.valid ? this.predictor.prediction : null;
  }

  private updateAirState(): void {
    const s = this.snapshot;
    const air = s.air;
    const st = this.vehicle.state;
    const inAir = this.jumpPhase === 'air' || this.jumpPhase === 'jump';
    air.airborne = inAir;
    air.tricks = this.tricks.tricks;
    air.rotation = this.tricks.rotation;
    if (inAir) {
      air.airTime = s.time - this.airStart;
      _v.subVectors(st.position, this.takeoffPos);
      air.distance = Math.hypot(_v.x, _v.z);
      air.maxHeight = this.maxHeight;
      const h = this.physics.raycast(st.position, DOWN, 2000, this.heightHit);
      air.height = h ? Math.max(0, h.distance - RIDE_HEIGHT) : Infinity;
      const kinds = this.tricks.distinctKinds;
      const chain = this.scoring.chainFor('clean', s.time);
      air.pendingPoints = Math.round(
        jumpBasePoints(air.airTime, air.distance, this.tricks.tricks) * comboMultiplier(kinds) * chainMultiplier(chain),
      );
    } else {
      air.airTime = 0;
      air.distance = 0;
      air.height = 0;
      air.pendingPoints = 0;
      if (this.jumpPhase === 'ground') air.maxHeight = 0;
    }
  }

  private updateFinish(): void {
    const s = this.snapshot;
    if (this.finishCandidate) {
      // the landing counts once every objective before the final one is complete — including one
      // completed by this very landing (objectives were evaluated earlier in this tick)
      if (this.objectives.readyForFinish) this.pendingFinish = this.finishCandidate;
      this.finishCandidate = null;
    }
    const pf = this.pendingFinish;
    if (!pf || s.phase !== 'running') return;
    if (pf.landing.quality === 'crash') {
      this.pendingFinish = null;
      return;
    }
    const wait = Math.max(this.level.finish.settleTime, TUNING.landing.settleTime);
    if (s.time - pf.start < wait) return;
    this.pendingFinish = null;
    s.phase = 'complete';
    this.objectiveEvents.length = 0;
    this.objectives.completeAll(s.time, this.objectiveEvents);
    for (const e of this.objectiveEvents) this.tickEvents.push(e);
    const result = buildLevelResult(this.level, s.score, pf.start, pf.landing);
    s.result = result;
    this.tickEvents.push({ type: 'levelComplete', result });
  }

  private updateTimeScale(): void {
    const s = this.snapshot;
    let ts = 1;
    if (s.time < this.crashSlowUntil) ts = Math.min(ts, TUNING.crash.timeScale);
    if (s.time < this.perfectSlowUntil) ts = Math.min(ts, TUNING.perfectSlowMo.timeScale);
    if (s.phase === 'running') ts = Math.min(ts, this.objectives.requestedTimeScale);
    s.timeScale = ts;
  }
}
