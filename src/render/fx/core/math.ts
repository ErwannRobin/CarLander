/**
 * Small allocation-free math helpers shared by the FX module.
 * Everything writes into caller-provided outputs; nothing here allocates per call
 * (except `linearRGB`, which is meant for module-level constants).
 */
import { Color, type Object3D, Vector3 } from 'three';

export type RGB = readonly [number, number, number];

/** Uniform random number in [a, b). */
export function rand(a: number, b: number): number {
  return a + (b - a) * Math.random();
}

/** Uniform random number in [-1, 1). */
export function randSigned(): number {
  return Math.random() * 2 - 1;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential smoothing factor for a rate in 1/s. */
export function damp(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

/** Random unit vector (uniform on the sphere). */
export function randomUnitVector(out: Vector3): Vector3 {
  const z = Math.random() * 2 - 1;
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return out.set(r * Math.cos(a), r * Math.sin(a), z);
}

/**
 * Orthonormal tangent basis (t, b) for a unit normal n (Duff et al. 2017, branchless ONB).
 * (t, b, n) is right-handed.
 */
export function tangentBasis(n: Vector3, t: Vector3, b: Vector3): void {
  const sign = n.z >= 0 ? 1 : -1;
  const a = -1 / (sign + n.z);
  const bb = n.x * n.y * a;
  t.set(1 + sign * n.x * n.x * a, sign * bb, -sign * n.x);
  b.set(bb, sign + n.y * n.y * a, -n.y);
}

const _t = new Vector3();
const _b = new Vector3();

/**
 * Projects `v` onto the plane with unit normal `n` and normalizes it in place. When `v` is (nearly)
 * parallel to `n`, falls back to a tangent of `n`, so the result is always a valid unit vector.
 */
export function projectOnPlaneSafe(v: Vector3, n: Vector3): Vector3 {
  v.addScaledVector(n, -v.dot(n));
  const l2 = v.lengthSq();
  if (l2 < 1e-8) {
    tangentBasis(n, v, _b);
    return v;
  }
  return v.multiplyScalar(1 / Math.sqrt(l2));
}

/** Random direction inside a cone of half-angle `angle` (rad) around the unit `axis`. */
export function randomInCone(out: Vector3, axis: Vector3, angle: number): Vector3 {
  tangentBasis(axis, _t, _b);
  const cosA = Math.cos(angle);
  const z = cosA + (1 - cosA) * Math.random();
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = Math.random() * Math.PI * 2;
  const x = r * Math.cos(phi);
  const y = r * Math.sin(phi);
  return out.set(
    _t.x * x + _b.x * y + axis.x * z,
    _t.y * x + _b.y * y + axis.y * z,
    _t.z * x + _b.z * y + axis.z * z,
  );
}

/**
 * Random point on a disc of radius `radius` in the plane with unit normal `n`, added to `center`.
 * `t`/`b` must be the tangent basis of `n` (see tangentBasis).
 */
export function pointOnDisc(out: Vector3, center: Vector3, t: Vector3, b: Vector3, radius: number): Vector3 {
  const r = radius * Math.sqrt(Math.random());
  const a = Math.random() * Math.PI * 2;
  const x = r * Math.cos(a);
  const y = r * Math.sin(a);
  return out.set(center.x + t.x * x + b.x * y, center.y + t.y * x + b.y * y, center.z + t.z * x + b.z * y);
}

const _toCam = new Vector3();

/**
 * 0..1: how closely the line of sight from `camera` to `point` follows the unit `axis` (1 = looking
 * straight along it, 0 = seeing it side-on). Used to thin trails seen end-on from the chase camera.
 */
export function viewAlignment(camera: Object3D, point: Vector3, axis: Vector3): number {
  camera.getWorldPosition(_toCam).sub(point);
  const len = _toCam.length();
  return len < 1e-3 ? 1 : Math.abs(_toCam.dot(axis)) / len;
}

/** Linear-space RGB triple from an sRGB hex color (ColorManagement converts on `set`). Module constants only. */
export function linearRGB(hex: string, scale = 1): RGB {
  const c = new Color(hex);
  return [c.r * scale, c.g * scale, c.b * scale];
}

/** Linear-space color as a three.js Color (for uniforms). */
export function linearColor(hex: string, scale = 1): Color {
  const c = new Color(hex);
  return c.multiplyScalar(scale);
}

/**
 * Converts a continuous emission rate (particles / s) into an integer count per frame,
 * carrying the fractional remainder so low rates still emit at the right average frequency.
 */
export class RateAccumulator {
  private acc = Math.random();

  /** Number of particles to emit this frame (capped by `max` to protect the pool on long frames). */
  take(rate: number, dt: number, max = 48): number {
    if (rate <= 0 || dt <= 0) return 0;
    this.acc += rate * dt;
    const n = Math.floor(this.acc);
    this.acc -= n;
    return n > max ? max : n;
  }

  reset(): void {
    this.acc = Math.random();
  }
}
