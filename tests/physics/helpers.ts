/**
 * Shared helpers for the physics / sim test suites (not a test file itself).
 */
import { Euler, Quaternion, Vector3 } from 'three';
import { initPhysics } from '@/game/physics/initPhysics';
import { GameSim, type GameSimOptions } from '@/game/sim/GameSim';
import { TUNING } from '@/game/tuning';
import { NEUTRAL_INPUT, type GameEvent, type InputState, type LevelDef } from '@/game/types';

export const DT = TUNING.dt;
export const G = TUNING.gravity;
export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;
export const KMH = 3.6;

export const input = (o: Partial<InputState> = {}): InputState => ({ ...NEUTRAL_INPUT, ...o });

/** New sim with physics initialized. Defaults: not first attempt, flight assist off (pure controls). */
export async function createSim(level: LevelDef, opts: GameSimOptions = {}): Promise<GameSim> {
  await initPhysics();
  return new GameSim(level, { firstAttempt: false, flightAssist: false, ...opts });
}

export type InputSource = InputState | ((sim: GameSim, t: number) => InputState);

/**
 * Steps `sim` for `seconds` (sim time). Returns every event emitted. `onTick` runs after each step
 * with the elapsed time and that tick's events; returning `true` stops early.
 */
export function run(
  sim: GameSim,
  seconds: number,
  source: InputSource = NEUTRAL_INPUT,
  onTick?: (t: number, events: GameEvent[]) => boolean | void,
): GameEvent[] {
  const all: GameEvent[] = [];
  const n = Math.round(seconds / DT);
  let t = 0;
  for (let i = 0; i < n; i++) {
    sim.step(typeof source === 'function' ? source(sim, t) : source);
    t += DT;
    const evs = sim.drainEvents();
    for (const e of evs) all.push(e);
    if (onTick?.(t, evs)) break;
  }
  return all;
}

/**
 * Chassis attitude from track-convention angles (deg): yaw about +Y (+ = left), then pitch about
 * +X (+ = nose up), then roll about forward (+ = roll right).
 */
export function attitude(pitchDeg = 0, rollDeg = 0, yawDeg = 0): Quaternion {
  return new Quaternion().setFromEuler(new Euler(pitchDeg * D2R, yawDeg * D2R, -rollDeg * D2R, 'YXZ'));
}

/** Tilt (deg) between the chassis up and world up. */
export function tiltDeg(sim: GameSim): number {
  return Math.acos(Math.max(-1, Math.min(1, sim.snapshot.vehicle.up.y))) * R2D;
}

export interface DropSpec {
  /** Speed into the ground at first wheel contact (m/s). */
  impact: number;
  pitchDeg?: number;
  rollDeg?: number;
  /** Horizontal velocity angle from the heading (deg, toward the right). */
  driftDeg?: number;
  /** Horizontal speed (m/s). */
  horizontal?: number;
  x?: number;
  z?: number;
}

/**
 * Places the car above flat ground (surface at y = 0) so it touches down with a controlled
 * vertical speed after ≥ 0.4 s of free fall (long enough to count as a scored jump).
 */
export function placeForDrop(sim: GameSim, d: DropSpec): void {
  const v0 = Math.max(0, d.impact - 6);
  const h = (d.impact * d.impact - v0 * v0) / (2 * G);
  const drift = (d.driftDeg ?? 0) * D2R;
  const vh = d.horizontal ?? 10;
  // first wheel contact when the chassis origin is ≈ 0.48 m above the ground (level car)
  sim.placeVehicle(
    new Vector3(d.x ?? 0, 0.48 + h, d.z ?? 0),
    attitude(d.pitchDeg ?? 0, d.rollDeg ?? 0),
    new Vector3(Math.sin(drift) * vh, -v0, -Math.cos(drift) * vh),
  );
  sim.drainEvents();
}

export function ofType<T extends GameEvent['type']>(events: GameEvent[], type: T): Extract<GameEvent, { type: T }>[] {
  return events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);
}
