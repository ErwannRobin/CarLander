import RAPIER from '@dimforge/rapier3d-compat';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { createVehicleState } from '../snapshot';
import { TUNING } from '../tuning';
import type { GameEvent, InputState, LevelDef, VehicleState } from '../types';
import { CHASSIS_COLLIDERS, HARDPOINTS, VEHICLE } from '../vehicleSpec';
import { BodyState, rotationVectorBetween, rotationVectorBetweenQuats } from './BodyState';
import { CAR_GROUPS, createRayHit, type PhysicsWorld, type RayHit, type SurfaceInfo } from './PhysicsWorld';
import { approach, clamp, DEG, sanitizeInput, smoothstep } from './util';
import { VacuumSystem } from './VacuumSystem';

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

export interface VehicleOptions {
  fuel: LevelDef['fuel'];
  vacuumEnabled: boolean;
  /** Weak automatic leveling in the air when no rotation input is held (default true). */
  flightAssist?: boolean;
}

export interface VehicleSpawn {
  position: Vector3;
  quaternion: Quaternion;
  /** Initial forward speed (m/s). */
  speed?: number;
}

export interface VehicleStepInput {
  input: Readonly<InputState>;
  /** Predicted landing-surface normal for the stabilizer; world up when null. */
  stabilizeNormal: Vector3 | null;
}

/** A chassis (body collider) contact with static geometry, gathered after each step. */
export interface ChassisContact {
  /** World contact point. */
  point: Vector3;
  /** Contact point in chassis-local coordinates. */
  local: Vector3;
  /** Surface normal, pointing from the surface toward the car. */
  normal: Vector3;
  /** Index into CHASSIS_COLLIDERS (0 = tub, 1 = cabin). */
  collider: number;
  /** Signed distance (negative = penetration). */
  depth: number;
  /**
   * Real touch (depth within a few mm). Rapier also reports speculative contacts a few cm before
   * impact — those already stop the body, so impact speeds must be measured on them.
   */
  touching: boolean;
  /** Static collider handle that was touched. */
  surfaceHandle: number;
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

/**
 * Longitudinal tire mode: 'drive' = fixed drive impulse request (subject to the friction circle);
 * 'constrain' = drive the longitudinal slip velocity to 0, limited by `cap` (brake / coast / hold).
 */
type LongMode = 'drive' | 'constrain';

interface WheelSim {
  readonly index: number;
  readonly front: boolean;
  readonly left: boolean;
  readonly hardpoint: Vector3;
  hit: boolean;
  wasHit: boolean;
  springLength: number;
  compression: number;
  compressionVel: number;
  readonly point: Vector3;
  readonly normal: Vector3;
  surface: SurfaceInfo | null;
  readonly ray: RayHit;
  load: number;
  steer: number;
  // tire solver
  readonly fwd: Vector3;
  readonly side: Vector3;
  readonly app: Vector3;
  active: boolean;
  mLong: number;
  mLat: number;
  jLong: number;
  jLat: number;
  jDrive: number;
  cap: number;
  maxJ: number;
  mode: LongMode;
  vLong0: number;
  vLat0: number;
  saturated: boolean;
  // visuals
  visualLength: number;
  spinRate: number;
  spinAngle: number;
  /** Combined 0..1 slip for smoke/squeal; `slipLong` alone drives visual wheelspin. */
  slip: number;
  slipLong: number;
  slamCooldown: number;
}

const WORLD_UP = new Vector3(0, 1, 0);
const TWO_PI = Math.PI * 2;
const MAX_LINEAR_SPEED = 160;
const MAX_ANGULAR_SPEED = 30;
const MAX_CONTACTS = 8;
/** A chassis contact counts as a real touch up to this separation (m). */
const TOUCH_TOLERANCE = 0.004;
/** Speculative contacts are gathered up to this separation (m). */
const SPECULATIVE_RANGE = 0.05;

// scratch
const _v = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _dir = new Vector3();
const _hp = new Vector3();
const _nAvg = new Vector3();
const _wl = new Vector3();
const _wdes = new Vector3();
const _m4 = new Matrix4();
const _qt = new Quaternion();
const _tUp = new Vector3();
const _tFwd = new Vector3();
const _tRight = new Vector3();
const _tBack = new Vector3();
// air-control per-axis scratch (pitch, yaw, roll) — no per-tick array allocations
const _axIn = [0, 0, 0];
const _axTarget = [0, 0, 0];
const _axW = [0, 0, 0];
const _axDes = [0, 0, 0];
const _axRcs = [0, 0, 0];
const AIR_RATES = [TUNING.airPitchRate, TUNING.airYawRate, TUNING.airRollRate] as const;

function finite3(v: { x: number; y: number; z: number } | undefined): boolean {
  return v === undefined || Number.isFinite(v.x + v.y + v.z);
}

function makeWheel(i: number): WheelSim {
  const hp = HARDPOINTS[i];
  return {
    index: i,
    front: i < 2,
    left: i % 2 === 0,
    hardpoint: new Vector3(hp[0], hp[1], hp[2]),
    hit: false,
    wasHit: false,
    springLength: VEHICLE.suspension.restLength,
    compression: 0,
    compressionVel: 0,
    point: new Vector3(),
    normal: new Vector3(0, 1, 0),
    surface: null,
    ray: createRayHit(),
    load: 0,
    steer: 0,
    fwd: new Vector3(),
    side: new Vector3(),
    app: new Vector3(),
    active: false,
    mLong: 0,
    mLat: 0,
    jLong: 0,
    jLat: 0,
    jDrive: 0,
    cap: 0,
    maxJ: 0,
    mode: 'constrain',
    vLong0: 0,
    vLat0: 0,
    saturated: false,
    visualLength: VEHICLE.suspension.hardpointY,
    spinRate: 0,
    spinAngle: 0,
    slip: 0,
    slipLong: 0,
    slamCooldown: 0,
  };
}

/**
 * Custom raycast vehicle on a Rapier dynamic body (ARCHITECTURE §5).
 *
 * Per tick: `preStep()` senses the ground with 4 suspension rays and applies every vehicle
 * impulse to a local BodyState mirror (suspension + anti-roll, tire contact solver with a friction
 * circle, AWD e-motor / brakes / reverse, aero, thrust, air control / stabilizer / flight assist,
 * ground assists, vacuum), then writes the velocities back. The owner then calls
 * `physics.step()` (gravity, chassis contacts with CCD) and `postStep()` to publish the
 * resulting VehicleState.
 */
export class Vehicle {
  readonly rb: RAPIER.RigidBody;
  readonly colliders: RAPIER.Collider[] = [];
  readonly state: VehicleState;
  readonly vacuum: VacuumSystem;
  readonly body: BodyState;

  /** Chassis contacts (incl. speculative) from the last step (first `contactCount` entries valid). */
  readonly contacts: ChassisContact[] = [];
  contactCount = 0;
  /** How many of `contacts` are real touches. */
  touchingCount = 0;
  /** Velocity change caused by contacts during the last step (m/s). */
  contactDeltaV = 0;
  /** Velocity at the start of the last preStep (before vehicle impulses). */
  readonly preVelocity = new Vector3();
  /** Average contact normal of grounded wheels (valid when groundedWheels > 0). */
  readonly groundNormal = new Vector3(0, 1, 0);
  /** Seconds since any wheel last touched. */
  airTime = 0;
  /** Seconds without rotation input while airborne (flight assist trigger). */
  noRotationInputTime = 0;
  crashed = false;

  private readonly physics: PhysicsWorld;
  private readonly wheels: WheelSim[] = [0, 1, 2, 3].map(makeWheel);
  private readonly fuelDef: LevelDef['fuel'];
  private flightAssist: boolean;
  private steerNorm = 0;
  private fuel = 1;
  private regenTimer = 0;
  private thrusting = false;
  private fuelEmptyLatched = false;
  private jumping = false;
  private jumpEmptyLatched = false;
  private readonly input: InputState = { throttle: 0, steer: 0, roll: 0, boost: false, jump: false, vacuum: false, stabilize: false };
  private readonly writtenVelocity = new Vector3();
  private readonly lastGood: BodyState;
  private readonly tv = { x: 0, y: 0, z: 0 };
  private readonly tv2 = { x: 0, y: 0, z: 0 };
  private readonly tq = { x: 0, y: 0, z: 0, w: 1 };

  constructor(physics: PhysicsWorld, spawn: VehicleSpawn, opts: VehicleOptions, state?: VehicleState) {
    this.physics = physics;
    this.fuelDef = opts.fuel;
    this.flightAssist = opts.flightAssist ?? true;
    this.state = state ?? createVehicleState();
    this.body = new BodyState(VEHICLE.mass, VEHICLE.inertia, VEHICLE.centerOfMass);
    this.lastGood = new BodyState(VEHICLE.mass, VEHICLE.inertia, VEHICLE.centerOfMass);
    for (let i = 0; i < MAX_CONTACTS; i++) {
      this.contacts.push({
        point: new Vector3(),
        local: new Vector3(),
        normal: new Vector3(0, 1, 0),
        collider: 0,
        depth: 0,
        touching: false,
        surfaceHandle: -1,
      });
    }

    const p = spawn.position;
    const q = spawn.quaternion;
    const speed = spawn.speed ?? 0;
    if (!finite3(p) || !Number.isFinite(q.x + q.y + q.z + q.w) || !Number.isFinite(speed)) {
      throw new TypeError('Vehicle: the spawn pose / speed must be finite (check LevelDef.spawn).');
    }
    const fwd = _v.set(0, 0, -1).applyQuaternion(q);
    const [cx, cy, cz] = VEHICLE.centerOfMass;
    const [ix, iy, iz] = VEHICLE.inertia;
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(p.x, p.y, p.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setLinvel(fwd.x * speed, fwd.y * speed, fwd.z * speed)
      .setAdditionalMassProperties(VEHICLE.mass, { x: cx, y: cy, z: cz }, { x: ix, y: iy, z: iz }, { x: 0, y: 0, z: 0, w: 1 })
      .setCcdEnabled(true)
      // Gravity is applied by the vehicle as the first impulse of each tick (see preStep): Rapier's
      // substepping would otherwise leave a steady −0.375·g·dt velocity on a car at rest, and the
      // tire solver must see gravity's slope component in the same tick to hold the car still.
      .setGravityScale(0)
      .setCanSleep(false)
      .setLinearDamping(0)
      .setAngularDamping(0);
    this.rb = physics.world.createRigidBody(desc);
    for (const c of CHASSIS_COLLIDERS) {
      const cd = RAPIER.ColliderDesc.roundCuboid(c.halfExtents[0], c.halfExtents[1], c.halfExtents[2], c.borderRadius)
        .setTranslation(c.center[0], c.center[1], c.center[2])
        .setDensity(0)
        .setFriction(0.4)
        .setRestitution(0.05)
        .setCollisionGroups(CAR_GROUPS)
        .setSolverGroups(CAR_GROUPS);
      this.colliders.push(physics.world.createCollider(cd, this.rb));
    }

    this.vacuum = new VacuumSystem(physics, opts.vacuumEnabled, this.state.vacuum);
    this.fuel = clamp(opts.fuel.start, 0, 1);
    this.body.read(this.rb);
    this.lastGood.copyKinematics(this.body);
    this.writtenVelocity.copy(this.body.linvel);
    this.preVelocity.copy(this.body.linvel);
    this.resetVisualState();
    this.publishState();
  }

  /* ---------------------------------------------------------------- */
  /* Public API                                                        */
  /* ---------------------------------------------------------------- */

  setOptions(opts: { flightAssist?: boolean }): void {
    if (opts.flightAssist !== undefined) this.flightAssist = opts.flightAssist;
  }

  get fuelLevel(): number {
    return this.fuel;
  }

  get grounded(): boolean {
    return this.state.groundedWheels > 0;
  }

  /**
   * Teleports the chassis (tests / debug tools). Velocities in world space.
   * Throws on non-finite input: it would otherwise also become the last-good recovery state.
   */
  teleport(position: Vector3, quaternion: Quaternion, linvel?: Vector3, angvel?: Vector3): void {
    if (!finite3(position) || !Number.isFinite(quaternion.x + quaternion.y + quaternion.z + quaternion.w) || !finite3(linvel) || !finite3(angvel)) {
      throw new TypeError('Vehicle.teleport: position, rotation and velocities must be finite.');
    }
    const t = this.tv;
    t.x = position.x;
    t.y = position.y;
    t.z = position.z;
    this.rb.setTranslation(t, true);
    const r = this.tq;
    r.x = quaternion.x;
    r.y = quaternion.y;
    r.z = quaternion.z;
    r.w = quaternion.w;
    this.rb.setRotation(r, true);
    t.x = linvel?.x ?? 0;
    t.y = linvel?.y ?? 0;
    t.z = linvel?.z ?? 0;
    this.rb.setLinvel(t, true);
    t.x = angvel?.x ?? 0;
    t.y = angvel?.y ?? 0;
    t.z = angvel?.z ?? 0;
    this.rb.setAngvel(t, true);
    this.body.read(this.rb);
    this.lastGood.copyKinematics(this.body);
    this.writtenVelocity.copy(this.body.linvel);
    this.preVelocity.copy(this.body.linvel);
    for (const w of this.wheels) {
      w.hit = false;
      w.wasHit = false;
    }
    this.publishState();
  }

  /** Overrides the fuel level (0..1) — tests / debug. */
  setFuel(f: number): void {
    this.fuel = clamp(f, 0, 1);
    this.state.fuel = this.fuel;
  }

  /* ---------------------------------------------------------------- */
  /* Tick                                                              */
  /* ---------------------------------------------------------------- */

  /** Computes and applies all vehicle impulses for this tick. Call before `physics.step()`. */
  preStep(step: VehicleStepInput, events: GameEvent[]): void {
    const dt = TUNING.dt;
    const b = this.body;
    b.read(this.rb);
    if (!b.isFinite()) {
      this.recover();
      b.read(this.rb);
    }
    this.preVelocity.copy(b.linvel);
    const input = sanitizeInput(step.input, this.input);
    if (this.crashed) {
      input.throttle = 0;
      input.steer = 0;
      input.roll = 0;
      input.boost = false;
      input.jump = false;
      input.stabilize = false;
      input.vacuum = false;
    }

    // --- ground sensing & air debounce ---------------------------------
    const grounded = this.senseWheels(dt, events);
    // gravity first (after sensing, so dampers see the true state velocity), then every other impulse
    b.linvel.y -= this.physics.gravity * dt;
    if (grounded > 0) this.airTime = 0;
    else this.airTime += dt;
    const airborne = grounded === 0 && this.airTime > TUNING.air.airborneDelay;
    this.state.airborne = airborne;
    this.state.groundedWheels = grounded;

    const vf = b.linvel.dot(b.forward);

    // --- steering -----------------------------------------------------------
    this.updateSteering(input.steer, vf, dt);

    // --- suspension ------------------------------------------------------------
    this.applySuspension(dt);

    // --- tires, drive, brakes ------------------------------------------------
    const throttle = airborne ? 0 : input.throttle;
    this.state.throttle = throttle;
    if (grounded > 0) this.solveTires(throttle, vf, dt);
    else
      for (const w of this.wheels) {
        w.saturated = false;
        w.slip = 0;
        w.slipLong = 0;
      }

    // --- aero ------------------------------------------------------------------
    this.applyAero(vf, grounded, dt);

    // --- thrusters & fuel -------------------------------------------------------
    this.applyThrust(input.boost, input.jump, airborne, events, dt);

    // --- rotation control (none after a crash: the wreck tumbles physically) ----------
    if (this.crashed) {
      this.state.rcs.pitch = 0;
      this.state.rcs.yaw = 0;
      this.state.rcs.roll = 0;
      this.state.stabilizing = false;
    } else if (airborne) this.applyAirControl(input, step.stabilizeNormal, dt);
    else {
      this.noRotationInputTime = 0;
      this.state.rcs.pitch = 0;
      this.state.rcs.yaw = 0;
      this.state.rcs.roll = 0;
      this.state.stabilizing = false;
      if (grounded >= 2) this.applyGroundAssists(vf, dt);
    }

    // --- vacuum ---------------------------------------------------------------------
    this.vacuum.step({ held: input.vacuum, groundedWheels: grounded, dt }, b, events);

    // --- sanitize & write back -------------------------------------------------------
    this.sanitizeVelocities();
    b.writeVelocities(this.rb);
    this.writtenVelocity.copy(b.linvel);
  }

  /** Reads back the stepped body and publishes VehicleState. Call after `physics.step()`. */
  postStep(): void {
    const b = this.body;
    b.read(this.rb);
    if (!b.isFinite()) {
      this.recover();
      b.read(this.rb);
    } else {
      this.lastGood.copyKinematics(b);
    }
    // contact-induced velocity change (the body has no Rapier gravity: every other force was applied in preStep)
    this.contactDeltaV = _v.copy(b.linvel).sub(this.writtenVelocity).length();
    this.gatherContacts();
    this.publishState();
  }

  dispose(): void {
    // Colliders/body are owned by the Rapier world, freed with PhysicsWorld.dispose().
    this.contactCount = 0;
    this.touchingCount = 0;
  }

  /* ---------------------------------------------------------------- */
  /* Sensing                                                           */
  /* ---------------------------------------------------------------- */

  private senseWheels(dt: number, events: GameEvent[]): number {
    const b = this.body;
    const sp = VEHICLE.suspension;
    const r = VEHICLE.wheelRadius;
    const maxDist = sp.restLength + r;
    _dir.copy(b.up).negate();
    let count = 0;
    _nAvg.set(0, 0, 0);
    for (const w of this.wheels) {
      w.wasHit = w.hit;
      w.slamCooldown = Math.max(0, w.slamCooldown - dt);
      b.pointToWorld(w.hardpoint, _hp);
      const hit = this.physics.raycast(_hp, _dir, maxDist, w.ray, { slot: w.index });
      // Ignore walls nearly parallel to the suspension axis (the chassis collider handles those) and
      // rays starting inside a solid (distance 0: hardpoint buried after a deep penetration) — the
      // surface is unknown there, and a bump-stop force along chassis up could only make it worse.
      if (!hit || hit.distance <= 1e-4 || hit.normal.dot(b.up) < 0.3) {
        w.hit = false;
        w.surface = null;
        w.compressionVel = 0;
        continue;
      }
      w.hit = true;
      count++;
      w.point.copy(hit.point);
      w.normal.copy(hit.normal);
      w.surface = hit.surface;
      _nAvg.add(hit.normal);
      const length = clamp(hit.distance - r, sp.minLength, sp.restLength);
      w.springLength = length;
      w.compression = sp.restLength - length;
      // Compression rate from the hardpoint velocity against the (smoothed) surface plane:
      // dL/dt = −(v·n)/(d·n)  ⇒  ẋ = (v·n)/(d·n). Facet-free and correct on curved ramps.
      b.velocityAt(_hp, _v);
      const dn = Math.min(_dir.dot(hit.normal), -0.25);
      w.compressionVel = clamp(_v.dot(hit.normal) / dn, -40, 40);

      // wheel slam (hard touchdown / bump-stop hit)
      const slamSpeed = w.compressionVel;
      if (w.slamCooldown <= 0 && slamSpeed > 4.5 && (!w.wasHit || length < TUNING.suspension.bumpStopStart)) {
        w.slamCooldown = 0.3;
        events.push({ type: 'wheelSlam', position: hit.point.clone(), strength: clamp((slamSpeed - 3) / 14, 0.05, 1) });
      }
    }
    if (count > 0) this.groundNormal.copy(_nAvg).normalize();
    return count;
  }

  /* ---------------------------------------------------------------- */
  /* Steering                                                          */
  /* ---------------------------------------------------------------- */

  private updateSteering(steerInput: number, vf: number, dt: number): void {
    const s = TUNING.steering;
    const toCenter = Math.abs(steerInput) < Math.abs(this.steerNorm) || steerInput * this.steerNorm < 0;
    this.steerNorm = approach(this.steerNorm, steerInput, (toCenter ? s.returnRate : s.rate) * dt);
    const maxAngle = (s.minAngleDeg + (s.maxAngleDeg - s.minAngleDeg) * Math.exp(-Math.abs(vf) / s.speedFalloff)) * DEG;
    // steer −1 (A / left) ⇒ positive angle (wheel turned to the car's left)
    const delta = -this.steerNorm * maxAngle;
    const L = VEHICLE.wheelbase;
    const T = VEHICLE.trackFront;
    let inner = delta;
    let outer = delta;
    if (Math.abs(delta) > 1e-4) {
      const R = L / Math.tan(Math.abs(delta));
      inner = Math.sign(delta) * Math.atan(L / Math.max(0.5, R - T / 2));
      outer = Math.sign(delta) * Math.atan(L / (R + T / 2));
    }
    // left turn (delta > 0): FL is the inner wheel
    this.wheels[0].steer = delta > 0 ? inner : outer;
    this.wheels[1].steer = delta > 0 ? outer : inner;
    this.wheels[2].steer = 0;
    this.wheels[3].steer = 0;
  }

  /** Mean front steer angle (rad, + = left). */
  get steerAngle(): number {
    return (this.wheels[0].steer + this.wheels[1].steer) / 2;
  }

  /* ---------------------------------------------------------------- */
  /* Suspension                                                        */
  /* ---------------------------------------------------------------- */

  private applySuspension(dt: number): void {
    const sp = TUNING.suspension;
    const b = this.body;
    for (const w of this.wheels) {
      w.load = 0;
      if (!w.hit) continue;
      const x = w.compression;
      const xd = w.compressionVel;
      let f = sp.stiffness * x + (xd > 0 ? sp.bumpDamping : sp.reboundDamping) * xd;
      if (w.springLength < sp.bumpStopStart) {
        const pen = sp.bumpStopStart - w.springLength;
        f += sp.bumpStopStiffness * pen * pen + (xd > 0 ? sp.bumpStopDamping * xd : 0);
      }
      w.load = f;
    }
    // anti-roll bars (only redistribute load between grounded wheels)
    this.antiRoll(this.wheels[0], this.wheels[1], sp.antiRollFront);
    this.antiRoll(this.wheels[2], this.wheels[3], sp.antiRollRear);
    for (const w of this.wheels) {
      if (!w.hit) continue;
      w.load = clamp(w.load, 0, sp.maxForce);
      if (w.load > 0) b.applyImpulseAt(w.normal, w.load * dt, w.point);
    }
  }

  private antiRoll(l: WheelSim, r: WheelSim, k: number): void {
    const xl = l.hit ? l.compression : 0;
    const xr = r.hit ? r.compression : 0;
    const f = (xl - xr) * k;
    if (l.hit) l.load += f;
    if (r.hit) r.load -= f;
  }

  /* ---------------------------------------------------------------- */
  /* Tires                                                             */
  /* ---------------------------------------------------------------- */

  /** Electric motor: constant force up to driveBaseSpeed, then constant power, soft-limited at maxSpeed. */
  static driveAccelAt(v: number): number {
    const base = TUNING.driveBaseSpeed;
    const a = v <= base ? TUNING.driveAccel : (TUNING.driveAccel * base) / v;
    const lim = clamp((TUNING.maxSpeed + TUNING.driveLimiterWidth * 0.35 - v) / TUNING.driveLimiterWidth, 0, 1);
    return a * lim;
  }

  static reverseAccelAt(v: number): number {
    return TUNING.reverseAccel * clamp((TUNING.reverseMaxSpeed - v) / 3, 0, 1);
  }

  private solveTires(throttle: number, vf: number, dt: number): void {
    const b = this.body;
    const t = TUNING.tire;
    const mass = b.mass;

    // ---- longitudinal intent -------------------------------------------------
    let mode: LongMode = 'constrain';
    let driveForce = 0; // signed along wheel forward (N)
    let brakeForce = 0; // magnitude (N)
    let hold = false;
    if (throttle > 0.02) {
      if (vf < -0.5) brakeForce = mass * TUNING.brakeDecel * throttle;
      else {
        mode = 'drive';
        driveForce = mass * Vehicle.driveAccelAt(Math.max(0, vf)) * throttle;
      }
    } else if (throttle < -0.02) {
      if (vf > 0.5) brakeForce = mass * TUNING.brakeDecel * -throttle;
      else {
        mode = 'drive';
        driveForce = -mass * Vehicle.reverseAccelAt(Math.max(0, -vf)) * -throttle;
      }
    } else if (Math.abs(vf) < TUNING.holdSpeed) hold = true;
    else brakeForce = mass * TUNING.coastDecel;

    // ---- per-wheel setup ----------------------------------------------------------
    let driveShareSum = 0;
    let loadSum = 0;
    for (const w of this.wheels) {
      if (!w.hit || w.load <= 0) continue;
      driveShareSum += w.front ? t.frontDriveShare : 1 - t.frontDriveShare;
      loadSum += w.load;
    }
    const comLift = t.forceLift;
    for (const w of this.wheels) {
      w.active = false;
      w.jLong = 0;
      w.jLat = 0;
      w.saturated = false;
      if (!w.hit || w.load <= 0) continue;
      const n = w.normal;
      // wheel heading: chassis forward rotated toward the left by the steer angle, on the contact plane
      const c = Math.cos(w.steer);
      const s = Math.sin(w.steer);
      w.fwd.copy(b.forward).multiplyScalar(c).addScaledVector(b.right, -s);
      w.fwd.addScaledVector(n, -w.fwd.dot(n));
      if (w.fwd.lengthSq() < 1e-4) continue;
      w.fwd.normalize();
      w.side.crossVectors(w.fwd, n); // right
      // application point: lifted toward the CoM height (roll influence)
      const h = Math.max(0, _v.subVectors(b.com, w.point).dot(n));
      w.app.copy(w.point).addScaledVector(n, h * comLift);
      w.mLong = b.effectiveMass(w.fwd, w.app);
      w.mLat = b.effectiveMass(w.side, w.app);
      b.velocityAt(w.app, _v);
      w.vLong0 = _v.dot(w.fwd);
      w.vLat0 = _v.dot(w.side);
      w.maxJ = t.friction * w.load * dt;
      const rolling = t.rollingResistance * w.load * dt;
      if (mode === 'drive') {
        const share = (w.front ? t.frontDriveShare : 1 - t.frontDriveShare) / Math.max(1e-6, driveShareSum);
        w.mode = 'drive';
        w.jDrive = driveForce * share * dt - Math.sign(w.vLong0) * (Math.abs(w.vLong0) > 0.2 ? rolling : 0);
        w.cap = 0;
      } else {
        w.mode = 'constrain';
        w.jDrive = 0;
        w.cap = hold ? w.maxJ : brakeForce * (w.load / Math.max(1e-6, loadSum)) * dt + rolling;
      }
      w.active = true;
    }

    // ---- sequential impulses ---------------------------------------------------------
    for (let it = 0; it < t.iterations; it++) {
      for (const w of this.wheels) {
        if (!w.active) continue;
        b.velocityAt(w.app, _v);
        let newLat = w.jLat - _v.dot(w.side) * w.mLat;
        let newLong: number;
        if (w.mode === 'drive') newLong = w.jDrive;
        else newLong = clamp(w.jLong - _v.dot(w.fwd) * w.mLong, -w.cap, w.cap);
        const mag = Math.hypot(newLong, newLat);
        if (mag > w.maxJ) {
          const k = w.maxJ / mag;
          newLong *= k;
          newLat *= k;
          w.saturated = true;
        } else if (it === t.iterations - 1) w.saturated = false;
        b.applyImpulseAt(w.fwd, newLong - w.jLong, w.app);
        b.applyImpulseAt(w.side, newLat - w.jLat, w.app);
        w.jLong = newLong;
        w.jLat = newLat;
      }
    }

    // ---- slip visuals ---------------------------------------------------------------------
    const launch = mode === 'drive' && throttle > 0.85 && vf >= 0 && vf < 7 ? 0.38 * (1 - vf / 7) : 0;
    for (const w of this.wheels) {
      if (!w.active) {
        w.slip = 0;
        w.slipLong = 0;
        continue;
      }
      const lat = smoothstep(0.8, t.slipVisualSpeed, Math.abs(w.vLat0));
      let lon = 0;
      if (w.mode === 'drive' && Math.abs(w.jDrive) > 1e-6) lon = clamp(1 - Math.abs(w.jLong) / Math.abs(w.jDrive), 0, 1);
      else if (w.mode === 'constrain' && w.saturated && Math.abs(w.vLong0) > 2) lon = 0.6;
      w.slipLong = clamp(Math.max(lon * 1.4, launch * (w.front ? 0.6 : 1)), 0, 1);
      w.slip = Math.max(lat, w.slipLong);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Aero                                                              */
  /* ---------------------------------------------------------------- */

  private applyAero(vf: number, grounded: number, dt: number): void {
    const b = this.body;
    const speed = b.linvel.length();
    if (speed > 0.01) b.linvel.addScaledVector(b.linvel, (-TUNING.aero.drag * speed * dt) / b.mass);
    if (grounded >= 2) b.linvel.addScaledVector(this.groundNormal, (-TUNING.aero.downforce * vf * vf * dt) / b.mass);
  }

  /* ---------------------------------------------------------------- */
  /* Thrust & fuel                                                     */
  /* ---------------------------------------------------------------- */

  private applyThrust(boostHeld: boolean, jumpHeld: boolean, airborne: boolean, events: GameEvent[], dt: number): void {
    const b = this.body;
    const cap = Math.max(0.1, this.fuelDef.capacity);
    const wasThrusting = this.thrusting;
    const wasJumping = this.jumping;
    // a new burn needs a little fuel, and an emptied tank needs the button released first
    const canStart = wasThrusting || this.fuel > 0.02;
    let thrusting = boostHeld && canStart && !this.fuelEmptyLatched && this.fuel > 0;
    if (thrusting) {
      const vAlong = b.linvel.dot(b.forward);
      const fade = clamp((TUNING.maxSpeedBoost - vAlong) / TUNING.boost.speedFade, 0, 1);
      b.linvel.addScaledVector(b.forward, TUNING.thrustAccel * fade * dt);
      this.fuel -= dt / cap;
      if (this.fuel <= 0) {
        this.fuel = 0;
        thrusting = false;
        if (!this.fuelEmptyLatched) events.push({ type: 'fuelEmpty' });
        this.fuelEmptyLatched = true;
      }
    }
    if (!boostHeld) this.fuelEmptyLatched = false;
    if (thrusting && !wasThrusting) events.push({ type: 'boostStart' });
    else if (!thrusting && wasThrusting) events.push({ type: 'boostEnd' });
    this.thrusting = thrusting;

    // vertical booster: same tank and the same start / empty rules as the main thrusters, but the
    // push is along the chassis up axis (underbody jets): a hop on the ground, a cushion when landing,
    // and a push away from the surface when the car is stuck to the crescent upside down
    const jump = TUNING.jump;
    let jumping = jumpHeld && (wasJumping || this.fuel > 0.02) && !this.jumpEmptyLatched && this.fuel > 0;
    if (jumping) {
      const vUp = b.linvel.dot(b.up);
      const fade = clamp((jump.maxClimb - vUp) / jump.speedFade, 0, 1);
      b.linvel.addScaledVector(b.up, jump.accel * fade * dt);
      this.fuel -= (dt / cap) * jump.fuelRate;
      if (this.fuel <= 0) {
        this.fuel = 0;
        jumping = false;
        if (!this.jumpEmptyLatched) events.push({ type: 'fuelEmpty' });
        this.jumpEmptyLatched = true;
      }
    }
    if (!jumpHeld) this.jumpEmptyLatched = false;
    if (jumping && !wasJumping) events.push({ type: 'jumpStart' });
    else if (!jumping && wasJumping) events.push({ type: 'jumpEnd' });
    this.jumping = jumping;

    // regen while grounded, after a delay since the last landing / burn
    if (airborne || thrusting || jumping) this.regenTimer = 0;
    else {
      this.regenTimer += dt;
      if (this.regenTimer >= this.fuelDef.regenDelay) this.fuel = Math.min(1, this.fuel + (this.fuelDef.regenPerSec * dt) / cap);
    }
    const target = thrusting ? 1 : 0;
    const rate = target > this.state.boostLevel ? TUNING.boost.levelRiseRate : TUNING.boost.levelFallRate;
    this.state.boostLevel = approach(this.state.boostLevel, target, rate * dt);
    this.state.boosting = thrusting;
    const jumpTarget = jumping ? 1 : 0;
    const jumpRate = jumpTarget > this.state.jumpLevel ? TUNING.boost.levelRiseRate : TUNING.boost.levelFallRate;
    this.state.jumpLevel = approach(this.state.jumpLevel, jumpTarget, jumpRate * dt);
    this.state.jumping = jumping;
    this.state.fuel = this.fuel;
  }

  /* ---------------------------------------------------------------- */
  /* Air control, stabilizer, flight assist                            */
  /* ---------------------------------------------------------------- */

  private applyAirControl(input: InputState, stabilizeNormal: Vector3 | null, dt: number): void {
    const b = this.body;
    const air = TUNING.air;
    const auth = this.thrusting ? air.thrustAuthority : 1;
    b.toLocal(b.angvel, _wl);
    const ins = _axIn;
    ins[0] = input.throttle;
    ins[1] = input.steer;
    ins[2] = input.roll;
    // W (+throttle) = nose down = −X rotation; A (−steer) = yaw left = +Y; E (+roll) = roll right = −Z
    const targets = _axTarget;
    for (let k = 0; k < 3; k++) targets[k] = -ins[k] * AIR_RATES[k] * auth;
    const anyInput = Math.abs(ins[0]) > 0.05 || Math.abs(ins[1]) > 0.05 || Math.abs(ins[2]) > 0.05;
    this.noRotationInputTime = anyInput ? 0 : this.noRotationInputTime + dt;

    const st = TUNING.stabilizer;
    const stabilize = input.stabilize;
    const assist = !stabilize && this.flightAssist && this.noRotationInputTime > st.assistDelay;
    this.state.stabilizing = stabilize;
    if (stabilize || assist) this.stabilizerRate(stabilizeNormal, assist, _wdes);

    const w = _axW;
    w[0] = _wl.x;
    w[1] = _wl.y;
    w[2] = _wl.z;
    const des = _axDes;
    des[0] = _wdes.x;
    des[1] = _wdes.y;
    des[2] = _wdes.z;
    const rcs = _axRcs;
    for (let k = 0; k < 3; k++) {
      const maxA = air.maxAccel[k] * auth * dt;
      let d: number;
      if (Math.abs(ins[k]) > 0.05) {
        d = clamp((targets[k] - w[k]) * TUNING.airControlResponse * auth * dt, -maxA, maxA);
      } else if (stabilize || assist) {
        const maxS = st.maxAccel * (assist ? 0.5 : 1) * dt;
        d = clamp((des[k] - w[k]) * st.response * dt, -maxS, maxS);
      } else {
        const mag = Math.abs(w[k]);
        d = -Math.sign(w[k]) * Math.min(mag, (TUNING.airDamping * mag + air.stopDecel) * dt);
      }
      w[k] += d;
      rcs[k] = clamp(d / Math.max(1e-6, air.maxAccel[k] * dt), -1, 1);
    }
    _wl.set(w[0], w[1], w[2]);
    b.toWorld(_wl, b.angvel);
    this.state.rcs.pitch = rcs[0];
    this.state.rcs.yaw = rcs[1];
    this.state.rcs.roll = -rcs[2];
  }

  /**
   * Desired body-local angular velocity that rotates the chassis toward the target attitude:
   * up = predicted landing normal (or world up), forward = velocity projected on that plane.
   */
  private stabilizerRate(normal: Vector3 | null, weak: boolean, out: Vector3): Vector3 {
    const b = this.body;
    const st = TUNING.stabilizer;
    _tUp.copy(normal ?? WORLD_UP).normalize();
    // heading reference: velocity on the target plane, else current forward, else (vertical) current up
    _tFwd.copy(b.linvel).addScaledVector(_tUp, -b.linvel.dot(_tUp));
    if (_tFwd.length() < st.headingMinSpeed) {
      _tFwd.copy(b.forward).addScaledVector(_tUp, -b.forward.dot(_tUp));
      if (_tFwd.lengthSq() < 0.04) {
        const sgn = b.forward.dot(_tUp) > 0 ? -1 : 1;
        _tFwd.copy(b.up).multiplyScalar(sgn).addScaledVector(_tUp, -sgn * b.up.dot(_tUp));
      }
    }
    if (_tFwd.lengthSq() < 1e-8) _tFwd.set(0, 0, -1);
    _tFwd.normalize();
    _tRight.crossVectors(_tFwd, _tUp).normalize();
    _tFwd.crossVectors(_tUp, _tRight).normalize();
    _tBack.copy(_tFwd).negate();
    _m4.makeBasis(_tRight, _tUp, _tBack);
    _qt.setFromRotationMatrix(_m4);
    rotationVectorBetweenQuats(b.quaternion, _qt, _v3);
    const gain = st.gain * (weak ? st.assistGain : 1);
    const maxRate = weak ? st.assistMaxRate : st.maxRate;
    _v3.multiplyScalar(gain);
    const len = _v3.length();
    if (len > maxRate) _v3.multiplyScalar(maxRate / len);
    return b.toLocal(_v3, out);
  }

  /* ---------------------------------------------------------------- */
  /* Ground assists                                                    */
  /* ---------------------------------------------------------------- */

  private applyGroundAssists(vf: number, dt: number): void {
    const b = this.body;
    const a = TUNING.assists;
    const n = this.groundNormal;

    // Rollover resistance: torque back toward the contact normal beyond a dead zone (roll axis only).
    rotationVectorBetween(b.up, n, _v2);
    const rollErr = _v2.dot(b.forward);
    const dz = a.rollDeadzoneDeg * DEG;
    if (Math.abs(rollErr) > dz) {
      const e = rollErr - Math.sign(rollErr) * dz;
      const wRoll = b.angvel.dot(b.forward);
      const alpha = clamp(a.rollStiffness * e - a.rollDamping * wRoll, -a.maxAccel, a.maxAccel);
      b.angvel.addScaledVector(b.forward, alpha * dt);
    }

    // Yaw stability: remove yaw-rate excess over what the steering/grip can explain (anti-spin).
    if (Math.abs(vf) > 4) {
      let load = 0;
      for (const w of this.wheels) load += w.load;
      const gEff = Math.max(2, load / b.mass);
      const r = b.angvel.dot(n);
      const maxR = (TUNING.tire.friction * gEff * 1.15) / Math.abs(vf);
      const rKin = clamp((vf * Math.tan(this.steerAngle)) / VEHICLE.wheelbase, -maxR, maxR);
      const margin = a.yawMargin + a.yawMarginFrac * Math.abs(rKin);
      const excess = r - rKin;
      const oversteer = Math.abs(r) > Math.abs(rKin) || Math.sign(r) !== Math.sign(rKin);
      if (oversteer && Math.abs(excess) > margin) {
        const over = excess - Math.sign(excess) * margin;
        const alpha = clamp(-over * a.yawGain, -a.maxAccel, a.maxAccel);
        b.angvel.addScaledVector(n, alpha * dt);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Safety                                                            */
  /* ---------------------------------------------------------------- */

  private sanitizeVelocities(): void {
    const b = this.body;
    if (!Number.isFinite(b.linvel.x + b.linvel.y + b.linvel.z)) b.linvel.copy(this.preVelocity);
    if (!Number.isFinite(b.angvel.x + b.angvel.y + b.angvel.z)) b.angvel.set(0, 0, 0);
    const v = b.linvel.length();
    if (v > MAX_LINEAR_SPEED) b.linvel.multiplyScalar(MAX_LINEAR_SPEED / v);
    const w = b.angvel.length();
    if (w > MAX_ANGULAR_SPEED) b.angvel.multiplyScalar(MAX_ANGULAR_SPEED / w);
  }

  /** Restores the last finite state (should never happen; guards against solver explosions). */
  private recover(): void {
    const g = this.lastGood;
    const t = this.tv;
    t.x = g.position.x;
    t.y = g.position.y;
    t.z = g.position.z;
    this.rb.setTranslation(t, true);
    const r = this.tq;
    r.x = g.quaternion.x;
    r.y = g.quaternion.y;
    r.z = g.quaternion.z;
    r.w = g.quaternion.w;
    this.rb.setRotation(r, true);
    t.x = 0;
    t.y = 0;
    t.z = 0;
    this.rb.setLinvel(t, true);
    this.rb.setAngvel(t, true);
  }

  /* ---------------------------------------------------------------- */
  /* Contacts                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Collects chassis contacts from the narrow phase after the step. Raw manifold contacts are used
   * (not solver contacts): trimesh pairs keep their raw contacts after the step but report no solver
   * contacts. Points are taken on the car side (collider-local + collider offset ⇒ chassis-local),
   * which is exact for any static shape type. Callbacks are pre-bound (no per-tick closures).
   */
  private gatherContacts(): void {
    this.contactCount = 0;
    this.touchingCount = 0;
    for (let ci = 0; ci < this.colliders.length; ci++) {
      this.gatherIndex = ci;
      this.physics.world.contactPairsWith(this.colliders[ci], this.onContactPair);
    }
  }

  private gatherIndex = 0;
  private gatherOther: RAPIER.Collider | null = null;

  private readonly onContactPair = (other: RAPIER.Collider): void => {
    this.gatherOther = other;
    this.physics.world.contactPair(this.colliders[this.gatherIndex], other, this.onManifold);
  };

  private readonly onManifold = (manifold: RAPIER.TempContactManifold, flipped: boolean): void => {
    const nc = manifold.numContacts();
    if (nc === 0) return;
    const offset = CHASSIS_COLLIDERS[this.gatherIndex].center;
    const mn = manifold.normal(this.tv);
    const sgn = flipped ? 1 : -1; // surface normal points from the static collider to the car
    const nx = mn.x * sgn;
    const ny = mn.y * sgn;
    const nz = mn.z * sgn;
    for (let k = 0; k < nc && this.contactCount < MAX_CONTACTS; k++) {
      const depth = manifold.contactDist(k);
      if (depth > SPECULATIVE_RANGE) continue;
      // the car is the manifold's second shape when flipped, else its first
      const lp = flipped ? manifold.localContactPoint2(k, this.tv2) : manifold.localContactPoint1(k, this.tv2);
      if (!lp) continue;
      const c = this.contacts[this.contactCount++];
      c.local.set(lp.x + offset[0], lp.y + offset[1], lp.z + offset[2]);
      this.body.pointToWorld(c.local, c.point);
      c.normal.set(nx, ny, nz).normalize();
      c.collider = this.gatherIndex;
      c.depth = depth;
      c.touching = depth <= TOUCH_TOLERANCE;
      if (c.touching) this.touchingCount++;
      c.surfaceHandle = this.gatherOther ? this.gatherOther.handle : -1;
    }
  };

  /* ---------------------------------------------------------------- */
  /* State publication                                                 */
  /* ---------------------------------------------------------------- */

  private resetVisualState(): void {
    for (const w of this.wheels) {
      w.visualLength = VEHICLE.suspension.hardpointY;
      w.spinAngle = 0;
      w.spinRate = 0;
      w.slip = 0;
    }
  }

  private publishState(): void {
    const b = this.body;
    const s = this.state;
    const dt = TUNING.dt;
    s.position.copy(b.position);
    s.quaternion.copy(b.quaternion);
    s.velocity.copy(b.linvel);
    s.angularVelocity.copy(b.angvel);
    s.forward.copy(b.forward);
    s.up.copy(b.up);
    s.right.copy(b.right);
    s.speed = b.linvel.length();
    s.forwardSpeed = b.linvel.dot(b.forward);
    s.crashed = this.crashed;
    s.fuel = this.fuel;
    const sp = VEHICLE.suspension;
    const r = VEHICLE.wheelRadius;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const ws = s.wheels[i];
      ws.grounded = w.hit;
      if (w.hit) w.visualLength = w.springLength;
      else w.visualLength = approach(w.visualLength, sp.restLength, TUNING.suspension.droopSpeed * dt);
      ws.suspensionLength = w.visualLength;
      ws.compression = clamp((sp.restLength - w.visualLength) / (sp.restLength - sp.minLength), 0, 1);
      ws.steerAngle = w.steer;
      if (w.hit) {
        // rolling speed from the contact-plane velocity + visual wheelspin
        b.pointToWorld(w.hardpoint, _hp);
        b.velocityAt(_hp, _v);
        const roll = _v.dot(b.forward);
        // visual wheelspin from longitudinal slip only (drive saturation / launch)
        w.spinRate = roll / r + (this.state.throttle !== 0 ? Math.sign(this.state.throttle) * w.slipLong * 30 : 0);
      } else {
        w.spinRate *= Math.exp(-0.35 * dt);
      }
      w.spinAngle = (w.spinAngle + w.spinRate * dt) % TWO_PI;
      ws.spinRate = w.spinRate;
      ws.spinAngle = w.spinAngle;
      ws.slip = w.hit ? w.slip : 0;
      ws.surface = w.hit && w.surface ? w.surface.kind : null;
      if (w.hit) {
        // contact point re-derived from the post-step pose (keeps VFX glued at speed)
        b.pointToWorld(w.hardpoint, _hp);
        ws.contactPoint.copy(_hp).addScaledVector(b.up, -w.visualLength).addScaledVector(w.normal, -r);
        ws.contactNormal.copy(w.normal);
      }
    }
    let grounded = 0;
    for (const w of this.wheels) if (w.hit) grounded++;
    s.groundedWheels = grounded;
  }
}
