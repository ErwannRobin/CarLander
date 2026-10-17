import type { InputState } from '../types';

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Moves `current` toward `target` by at most `maxDelta`. */
export function approach(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  return Math.abs(d) <= maxDelta ? target : current + Math.sign(d) * maxDelta;
}

function axis(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return clamp(n, -1, 1);
}

/** Copies `src` into `out` with axes clamped to [-1, 1] and non-finite values zeroed. */
export function sanitizeInput(src: Readonly<InputState>, out: InputState): InputState {
  out.throttle = axis(src.throttle);
  out.steer = axis(src.steer);
  out.roll = axis(src.roll);
  out.boost = src.boost === true;
  out.vacuum = src.vacuum === true;
  out.stabilize = src.stabilize === true;
  return out;
}

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
