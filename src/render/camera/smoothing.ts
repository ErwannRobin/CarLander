import { Vector3 } from 'three';

/**
 * Critically damped spring towards `target` (Unity-style SmoothDamp), frame-rate independent.
 * Mutates `current` and `velocity`. `smoothTime` ≈ time to reach the target (s).
 */
export function smoothDampVec3(current: Vector3, target: Vector3, velocity: Vector3, smoothTime: number, dt: number): Vector3 {
  const st = Math.max(1e-4, smoothTime);
  const omega = 2 / st;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const cx = current.x - target.x;
  const cy = current.y - target.y;
  const cz = current.z - target.z;
  const tx = (velocity.x + omega * cx) * dt;
  const ty = (velocity.y + omega * cy) * dt;
  const tz = (velocity.z + omega * cz) * dt;
  velocity.set((velocity.x - omega * tx) * exp, (velocity.y - omega * ty) * exp, (velocity.z - omega * tz) * exp);
  current.set(target.x + (cx + tx) * exp, target.y + (cy + ty) * exp, target.z + (cz + tz) * exp);
  return current;
}

export function smoothDamp(current: number, target: number, state: { v: number }, smoothTime: number, dt: number): number {
  const st = Math.max(1e-4, smoothTime);
  const omega = 2 / st;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (state.v + omega * change) * dt;
  state.v = (state.v - omega * temp) * exp;
  return target + (change + temp) * exp;
}

/** Exponential approach factor for rate k (1/s) over dt. */
export function damp(k: number, dt: number): number {
  return 1 - Math.exp(-k * dt);
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Cheap smooth 1D value noise in [-1, 1] (for camera shake). */
export function noise1(t: number, seed = 0): number {
  const i = Math.floor(t);
  const f = t - i;
  const h = (n: number) => {
    const s = Math.sin((n + seed * 157.31) * 127.1) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  const u = f * f * (3 - 2 * f);
  return h(i) * (1 - u) + h(i + 1) * u;
}
