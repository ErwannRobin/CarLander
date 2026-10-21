/**
 * Replay support. The sim is deterministic, so a replay is not a video: the runner logs the input
 * of every fixed tick, and a replay re-simulates the same ticks in a second GameSim (events, VFX
 * and audio come out exactly as in the live run). Pure TS, no DOM.
 */
import { TUNING } from './tuning';
import type { InputState } from './types';

/** Length of the exported / replayed clip (sim seconds). */
export const CLIP_SECONDS = 10;
/** The clip ends this long (sim seconds) after the finish, so the car is seen rolling out. */
export const CLIP_TAIL_SECONDS = 2;
/** Inputs are logged until this long after the finish (the clip never needs more). */
export const LOG_TAIL_TICKS = Math.ceil(CLIP_TAIL_SECONDS / TUNING.dt) + 8;

const STRIDE = 4;
const BOOST = 1;
const JUMP = 2;
const VACUUM = 4;
const STABILIZE = 8;
const ASSIST = 16;

/**
 * Per-tick input log. Stored as doubles (not quantised): a re-simulation must see exactly the
 * values the live run saw, or it drifts. Also logs the flight-assist setting of each tick.
 */
export class InputLog {
  private data = new Float64Array(STRIDE * 1024);
  length = 0;

  clear() {
    this.length = 0;
  }

  push(input: InputState, flightAssist: boolean) {
    const need = (this.length + 1) * STRIDE;
    if (need > this.data.length) {
      const grown = new Float64Array(Math.max(need, this.data.length * 2));
      grown.set(this.data);
      this.data = grown;
    }
    const o = this.length * STRIDE;
    this.data[o] = input.throttle;
    this.data[o + 1] = input.steer;
    this.data[o + 2] = input.roll;
    this.data[o + 3] =
      (input.boost ? BOOST : 0) |
      (input.jump ? JUMP : 0) |
      (input.vacuum ? VACUUM : 0) |
      (input.stabilize ? STABILIZE : 0) |
      (flightAssist ? ASSIST : 0);
    this.length++;
  }

  /** Writes tick `i` into `out` and returns whether flight assist was on for it. */
  read(i: number, out: InputState): boolean {
    const o = i * STRIDE;
    const f = this.data[o + 3];
    out.throttle = this.data[o];
    out.steer = this.data[o + 1];
    out.roll = this.data[o + 2];
    out.boost = (f & BOOST) !== 0;
    out.jump = (f & JUMP) !== 0;
    out.vacuum = (f & VACUUM) !== 0;
    out.stabilize = (f & STABILIZE) !== 0;
    return (f & ASSIST) !== 0;
  }
}

/** A moment worth slowing down for, on the sim tick it happened. */
export interface ReplayMoment {
  tick: number;
  /** Lowest time scale reached around it. */
  floor: number;
}

export interface ReplayClip {
  /** First and last tick (exclusive) of the clip. */
  start: number;
  end: number;
  moments: ReplayMoment[];
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The clip to replay: the last CLIP_SECONDS up to a short tail after the finish (or the end of the
 * log when the run was cut off earlier). `completeTick` is -1 when the run has no finish yet.
 */
export function planClip(logLength: number, completeTick: number, moments: readonly ReplayMoment[]): ReplayClip {
  const tail = Math.round(CLIP_TAIL_SECONDS / TUNING.dt);
  const end = Math.min(logLength, completeTick >= 0 ? completeTick + tail : logLength);
  const start = Math.max(0, end - Math.round(CLIP_SECONDS / TUNING.dt));
  return { start, end, moments: moments.filter((m) => m.tick >= start && m.tick <= end) };
}

/**
 * Director slow motion: eases down to each moment's floor just before it and back up after it.
 * 1 away from any moment. `tick` may be fractional.
 */
export function slowMotionAt(tick: number, moments: readonly ReplayMoment[]): number {
  let scale = 1;
  for (const m of moments) {
    const x = (tick - m.tick) * TUNING.dt; // seconds relative to the moment
    const bump = smooth(-0.75, -0.2, x) * (1 - smooth(0.55, 1.4, x));
    if (bump > 0) scale = Math.min(scale, 1 - (1 - m.floor) * bump);
  }
  return scale;
}
