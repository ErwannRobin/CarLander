/**
 * Ready-made autopilots for the physics test levels — reference solutions used by the headless
 * tests, the physics debug viewer (key `T`) and integration demo runs (`devHooks.autopilot =
 * demoPilotFor(level)?.asFunction()`). They only use snapshot-based conditions, so they work without
 * events.
 * Handcrafted levels should ship their own pilots built from the same `autopilot.ts` blocks.
 */
import { TEST_RAMP, TEST_RAMP_PATH, TEST_VACUUM, TEST_VACUUM_PATH } from '../levels/testLevels';
import type { LevelDef, SimSnapshot } from '../types';
import {
  Autopilot,
  cond,
  flipNTimes,
  followTrack,
  holdVacuumWhile,
  rollToUpright,
  stabilizeInAir,
  TrackTracker,
  type AutopilotPhase,
} from './autopilot';

export interface RampPilotOptions {
  /** Run-up speed (m/s). 36–40 lands in the target. */
  speed?: number;
  /** Backflips to attempt in the air (0 = none). */
  backflips?: number;
}

/** TEST_RAMP: follow the runway at `speed`, launch, (optional flips), stabilize, roll out. */
export function rampDemoPilot(opts: RampPilotOptions = {}): Autopilot {
  const frames = [TEST_RAMP_PATH.runway, TEST_RAMP_PATH.kicker, TEST_RAMP_PATH.landing];
  const speed = opts.speed ?? 40;
  const flips = opts.backflips ?? 0;
  const phases: AutopilotPhase[] = [
    { name: 'run-up', controllers: [followTrack(frames, speed)], until: cond.airborne(), timeout: 25 },
  ];
  if (flips > 0) {
    phases.push({
      name: 'tricks',
      controllers: [flipNTimes(flips, 'back')],
      until: (snap) => Math.abs(snap.air.rotation.pitch) >= flips * 360 - 50 || !snap.air.airborne,
      timeout: 4,
    });
  }
  phases.push(
    { name: 'stabilize', controllers: [stabilizeInAir()], until: cond.touchedDown(), timeout: 8 },
    { name: 'roll-out', controllers: [followTrack(frames, 10)] },
  );
  return new Autopilot(phases);
}

export interface VacuumPilotOptions {
  /** Approach / cruise speed (m/s). */
  speed?: number;
  /** Use roll keys (like a player) instead of the stabilizer after release. */
  manualRoll?: boolean;
}

/**
 * TEST_VACUUM: approach, hold ENTER from 50 m before the quarter pipe, climb, drive the inverted
 * beam, release 6 m before its end, roll upright (stabilizer or Q/E) and land on the hill.
 */
export function vacuumDemoPilot(opts: VacuumPilotOptions = {}): Autopilot {
  const P = TEST_VACUUM_PATH;
  const frames = [P.runway, P.crescent];
  const progress = new TrackTracker(frames);
  const s = (snap: SimSnapshot) => progress.update(snap.vehicle.position).s;
  const release = progress.length - 6;
  const speed = opts.speed ?? 26;
  return new Autopilot([
    {
      name: 'approach',
      controllers: [followTrack(frames, speed), holdVacuumWhile((snap) => s(snap) > P.runway[P.runway.length - 1].s - 50)],
      until: (snap) => s(snap) >= release,
      timeout: 45,
    },
    {
      name: 'release',
      controllers: opts.manualRoll ? [rollToUpright()] : [stabilizeInAir()],
      until: cond.touchedDown(),
      timeout: 10,
    },
    { name: 'roll-out', controllers: [followTrack(P.hill, 10)] },
  ]);
}

/**
 * Demo pilot for a test level (null for other levels). Matches by geometry (the `pieces` array), so a
 * re-labelled copy such as `{ ...TEST_RAMP, id: 2 }` still gets its pilot.
 */
export function demoPilotFor(level: LevelDef): Autopilot | null {
  if (level === TEST_RAMP || level.pieces === TEST_RAMP.pieces) return rampDemoPilot();
  if (level === TEST_VACUUM || level.pieces === TEST_VACUUM.pieces) return vacuumDemoPilot();
  return null;
}
