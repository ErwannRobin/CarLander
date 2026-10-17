/**
 * Sim-level robustness & contract tests (QA): ARCHITECTURE §4 API parity, snapshot instance
 * stability, reset in awkward moments, constant dt under slow motion, input sanitizing, and the
 * level-finish ordering when the finishing landing also completes the penultimate objective.
 */
import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { TEST_FLAT, TEST_RAMP, TEST_VACUUM } from '@/game/levels/testLevels';
import { initPhysics } from '@/game/physics/initPhysics';
import { runAutopilot } from '@/game/sim/autopilot';
import { rampDemoPilot, vacuumDemoPilot } from '@/game/sim/demoPilots';
import { GameSim } from '@/game/sim/GameSim';
import { createObjectiveHelpers } from '@/game/sim/objectiveHelpers';
import { TUNING } from '@/game/tuning';
import type { GameEvent, InputState, LevelDef, SimSnapshot } from '@/game/types';
import { attitude, createSim, DT, G, input, ofType, run } from '../physics/helpers';

describe('GameSim API parity (ARCHITECTURE §4)', () => {
  it('constructor / step / snapshot / poses / drainEvents / reset / setOptions / world / vehicle / dispose', async () => {
    await initPhysics();
    // the exact ARCHITECTURE signature (only firstAttempt) and the no-options form both work
    const sim = new GameSim(TEST_RAMP, { firstAttempt: true });
    const bare = new GameSim(TEST_FLAT);
    expect(bare.snapshot.levelId).toBe(TEST_FLAT.id);
    bare.dispose();

    expect(sim.snapshot.phase).toBe('ready');
    expect(sim.snapshot.tick).toBe(0);
    expect(sim.prevPose.position).toBeInstanceOf(Vector3);
    expect(sim.currPose.quaternion).toBeInstanceOf(Quaternion);
    // construction announces the first objective (no 'reset')
    expect(sim.drainEvents().map((e) => e.type)).toEqual(['objective']);
    expect(sim.drainEvents()).toEqual([]);

    sim.step(input({ throttle: 1 }));
    expect(sim.snapshot.phase).toBe('running');
    expect(sim.snapshot.tick).toBe(1);
    expect(sim.snapshot.time).toBeCloseTo(DT, 12);

    // debugging handles
    expect(typeof sim.world.step).toBe('function');
    expect(sim.world.gravity.y).toBe(-G);
    expect(sim.vehicle.state).toBe(sim.snapshot.vehicle);

    sim.setOptions({ flightAssist: false });
    sim.setOptions({ firstAttempt: false });
    sim.setOptions({});

    run(sim, 1, input({ throttle: 1 }));
    sim.reset();
    expect(sim.drainEvents().map((e) => e.type)).toEqual(['reset', 'objective']);
    expect(sim.snapshot.phase).toBe('ready');

    sim.dispose();
    // after dispose every entry point is inert (no WASM use-after-free)
    expect(() => {
      sim.step(input({ throttle: 1 }));
      sim.reset();
      sim.placeVehicle(new Vector3(), new Quaternion());
      sim.setOptions({ flightAssist: true });
      sim.dispose();
    }).not.toThrow();
    expect(sim.snapshot.tick).toBe(0);
  });

  it('rejects non-finite teleports instead of poisoning the last-good recovery state', async () => {
    const sim = await createSim(TEST_FLAT);
    expect(() => sim.placeVehicle(new Vector3(NaN, 0, 0), new Quaternion())).toThrow(/finite/);
    expect(() => sim.placeVehicle(new Vector3(), new Quaternion(), new Vector3(0, Infinity, 0))).toThrow(/finite/);
    run(sim, 0.5);
    expect(Number.isFinite(sim.snapshot.vehicle.position.y)).toBe(true);
    sim.dispose();
  });

  it('sanitizes non-finite / out-of-range input', async () => {
    const sim = await createSim(TEST_FLAT);
    const bad = { throttle: NaN, steer: Infinity, roll: -Infinity, boost: 1, vacuum: 'yes', stabilize: null } as unknown as InputState;
    run(sim, 1, bad);
    const v = sim.snapshot.vehicle;
    expect(v.throttle).toBe(0);
    expect(v.boosting).toBe(false);
    expect(Number.isFinite(v.position.x + v.velocity.x + v.angularVelocity.x)).toBe(true);
    run(sim, 1, input({ throttle: 7, steer: -3 })); // clamped to ±1
    expect(sim.snapshot.vehicle.throttle).toBe(1);
    expect(sim.snapshot.vehicle.wheels[0].steerAngle).toBeGreaterThan(0);
    sim.dispose();
  });
});

/** Every Vector3 / Quaternion reachable from the snapshot's persistent state objects. */
function persistentMath(s: SimSnapshot): object[] {
  const v = s.vehicle;
  const out: object[] = [v, v.position, v.quaternion, v.velocity, v.angularVelocity, v.forward, v.up, v.right, v.rcs, v.wheels];
  for (const w of v.wheels) out.push(w, w.contactPoint, w.contactNormal);
  out.push(v.vacuum, v.vacuum.surfacePoint, v.vacuum.surfaceNormal);
  out.push(s.air, s.air.rotation, s.air.tricks, s.score, s.objective);
  return out;
}

describe('snapshot instances', () => {
  it('are stable objects mutated in place across ticks and resets (prediction pooled)', async () => {
    const sim = await createSim(TEST_VACUUM, { flightAssist: true });
    const refs = persistentMath(sim.snapshot);
    const poses = [sim.prevPose.position, sim.prevPose.quaternion, sim.currPose.position, sim.currPose.quaternion];
    let prediction: SimSnapshot['prediction'] = null;
    const pathVectors = new Set<Vector3>();
    let predictedTicks = 0;
    const check = () => {
      const now = persistentMath(sim.snapshot);
      for (let i = 0; i < refs.length; i++) expect(now[i]).toBe(refs[i]);
      expect([sim.prevPose.position, sim.prevPose.quaternion, sim.currPose.position, sim.currPose.quaternion]).toEqual(poses);
      const p = sim.snapshot.prediction;
      if (p) {
        predictedTicks++;
        if (prediction) expect(p).toBe(prediction);
        prediction = p;
        for (const pt of p.path) pathVectors.add(pt);
      }
    };
    const report = runAutopilot(sim, vacuumDemoPilot({ speed: 26 }), { maxTime: 45, onTick: check });
    expect(report.stoppedBy).toBe('complete');
    expect(predictedTicks).toBeGreaterThan(100); // the release flight + the ceiling release preview
    expect(pathVectors.size).toBeLessThanOrEqual(TUNING.prediction.maxPoints); // pooled, never reallocated
    sim.reset();
    check();
    run(sim, 2, input({ throttle: 1 }), () => check());
    sim.dispose();
  });
});

describe('reset at awkward moments', () => {
  it('mid-air: clean spawn, no stale landing/takeoff, prediction and slow motion cleared', async () => {
    const sim = await createSim(TEST_RAMP, { firstAttempt: true });
    run(sim, 15, input({ throttle: 1 }), () => sim.snapshot.air.airborne && sim.snapshot.air.airTime > 0.6);
    expect(sim.snapshot.air.airborne).toBe(true);
    expect(sim.snapshot.prediction).not.toBeNull();
    expect(sim.snapshot.timeScale).toBeLessThan(1); // first-attempt stabilize prompt (bullet time)
    sim.reset();
    expect(sim.drainEvents().map((e) => e.type)).toEqual(['reset', 'objective']);
    const s = sim.snapshot;
    expect(s.air.airborne).toBe(false);
    expect(s.air.tricks).toHaveLength(0);
    expect(s.air.rotation).toEqual({ pitch: 0, yaw: 0, roll: 0 });
    expect(s.prediction).toBeNull();
    expect(s.prompt).toBeNull();
    expect(s.timeScale).toBe(1);
    expect(s.score.jumps).toBe(0);
    expect(s.vehicle.velocity.z).toBeCloseTo(-(TEST_RAMP.spawn.speed ?? 0), 6);
    const after = run(sim, 2);
    for (const t of ['landing', 'takeoff', 'crash', 'trick'] as const) expect(ofType(after, t)).toHaveLength(0);
    sim.dispose();
  });

  it('mid-crash (during the slow-motion request): phase, crash flags, controls and time scale restored', async () => {
    const sim = await createSim(TEST_FLAT);
    sim.placeVehicle(new Vector3(0, 2, 0), attitude(0, 180), new Vector3(0, -3, 0));
    run(sim, 1, undefined, () => sim.snapshot.phase === 'crashed');
    expect(sim.snapshot.timeScale).toBe(TUNING.crash.timeScale);
    sim.reset();
    sim.drainEvents();
    const s = sim.snapshot;
    expect(s.phase).toBe('ready');
    expect(s.crashReason).toBeNull();
    expect(s.vehicle.crashed).toBe(false);
    expect(s.timeScale).toBe(1);
    const events = run(sim, 2, input({ throttle: 1 }));
    expect(ofType(events, 'crash')).toHaveLength(0);
    expect(s.vehicle.throttle).toBe(1); // controls work again
    expect(s.vehicle.speed).toBeGreaterThan(20);
    sim.dispose();
  });
});

describe('slow motion never changes the physics step', () => {
  it('crash slow-mo: every tick still advances TUNING.dt and free fall keeps gaining g·dt', async () => {
    // fall from 200 m beside the deck; killY 100 ⇒ 'fell' crash mid-air, then keep falling
    const level: LevelDef = { ...TEST_FLAT, killY: 100 };
    const sim = await createSim(level);
    sim.placeVehicle(new Vector3(2000, 200, 0), new Quaternion());
    let slowTicks = 0;
    let prevVy = sim.snapshot.vehicle.velocity.y;
    let prevTime = sim.snapshot.time;
    run(sim, 4.5, undefined, () => {
      const s = sim.snapshot;
      expect(s.time - prevTime).toBeCloseTo(DT, 12);
      const dv = s.vehicle.velocity.y - prevVy;
      expect(Math.abs(dv + G * DT)).toBeLessThan(0.012); // gravity minus a little aero drag
      if (s.timeScale < 1) slowTicks++;
      prevVy = s.vehicle.velocity.y;
      prevTime = s.time;
    });
    expect(sim.snapshot.crashReason).toBe('fell');
    expect(slowTicks).toBe(Math.round(TUNING.crash.slowMoTime / DT));
    sim.dispose();
  });

  it('tutorial bullet-time and PERFECT slow-mo requests leave dt untouched', async () => {
    const sim = await createSim(TEST_RAMP, { firstAttempt: true });
    const pilot = rampDemoPilot({ speed: 36 });
    let recent: GameEvent[] = [];
    const scales = new Set<number>();
    let prevTime = 0;
    for (let i = 0; i < 120 * 25 && sim.snapshot.phase !== 'complete'; i++) {
      const inp = { ...pilot.next(sim.snapshot, recent) };
      if (sim.snapshot.air.airborne && sim.snapshot.air.airTime < 0.5) inp.stabilize = false; // hesitate ⇒ prompt
      sim.step(inp);
      recent = sim.drainEvents();
      scales.add(sim.snapshot.timeScale);
      expect(sim.snapshot.time - prevTime).toBeCloseTo(DT, 12);
      prevTime = sim.snapshot.time;
    }
    expect(sim.snapshot.phase).toBe('complete');
    expect([...scales].some((s) => s < 1)).toBe(true);
    sim.dispose();
  });
});

describe('level finish ordering', () => {
  it('a landing that completes the penultimate objective also finishes the level (same tick)', async () => {
    const H = createObjectiveHelpers(TEST_RAMP.zones);
    const level: LevelDef = {
      ...TEST_RAMP,
      objectives: [
        { id: 'go', title: 'GO', text: '', hints: [], complete: (ctx) => H.speedKmh(ctx) > 50 },
        // the penultimate objective completes with the very landing that should finish the level
        { id: 'land', title: 'LAND', text: '', hints: [], complete: (ctx) => H.landedIn(ctx, 'ramp-finish', 'clean') },
        { id: 'finish', title: 'FINISH', text: '', hints: [], complete: () => false },
      ],
    };
    const sim = await createSim(level);
    const report = runAutopilot(sim, rampDemoPilot({ speed: 40 }), { maxTime: 30 });
    expect(report.stoppedBy).toBe('complete');
    const ids = ofType(report.events, 'objectiveComplete').map((e) => e.id);
    expect(ids).toEqual(['go', 'land', 'finish']);
    expect(sim.snapshot.result?.finalLanding.quality).not.toBe('crash');
    sim.dispose();
  });

  it('a landing before the preceding objectives are done does not finish the level', async () => {
    const level: LevelDef = {
      ...TEST_RAMP,
      objectives: [
        { id: 'never', title: 'NEVER', text: '', hints: [], complete: () => false },
        { id: 'finish', title: 'FINISH', text: '', hints: [], complete: () => false },
      ],
    };
    const sim = await createSim(level);
    const report = runAutopilot(sim, rampDemoPilot({ speed: 40 }), { maxTime: 20 });
    expect(ofType(report.events, 'landing')).toHaveLength(1);
    expect(report.stoppedBy).not.toBe('complete');
    expect(sim.snapshot.phase).toBe('running');
    sim.dispose();
  });
});
