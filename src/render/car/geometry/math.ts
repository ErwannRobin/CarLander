/**
 * Small numeric helpers used by the procedural car geometry builders.
 * Everything here runs once at build time (not per frame), so clarity wins over micro-optimisation.
 */

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Signed power: sign(v) * |v|^p (keeps superellipse quadrants symmetric). */
export const spow = (v: number, p: number): number => (v < 0 ? -Math.pow(-v, p) : Math.pow(v, p));

/**
 * Monotone cubic Hermite interpolation (Fritsch–Carlson). C1-continuous and never overshoots the
 * control values, which makes it ideal for authoring body profiles from a handful of key heights.
 * Values outside the control range are clamped to the end values.
 */
export class MonotoneSpline {
  private readonly xs: Float64Array;
  private readonly ys: Float64Array;
  private readonly ms: Float64Array;

  constructor(points: ReadonlyArray<readonly [number, number]>) {
    const n = points.length;
    if (n < 2) throw new Error('MonotoneSpline needs at least 2 points');
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    this.ms = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.xs[i] = points[i][0];
      this.ys[i] = points[i][1];
      if (i > 0 && this.xs[i] <= this.xs[i - 1]) throw new Error('MonotoneSpline x values must increase');
    }
    const d = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i++) d[i] = (this.ys[i + 1] - this.ys[i]) / (this.xs[i + 1] - this.xs[i]);
    this.ms[0] = d[0];
    this.ms[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) {
      if (d[i - 1] * d[i] <= 0) {
        this.ms[i] = 0;
      } else {
        const h0 = this.xs[i] - this.xs[i - 1];
        const h1 = this.xs[i + 1] - this.xs[i];
        const common = h0 + h1;
        this.ms[i] = (3 * common) / ((common + h1) / d[i - 1] + (common + h0) / d[i]);
      }
    }
  }

  at(x: number): number {
    const { xs, ys, ms } = this;
    const n = xs.length;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    // binary search for the interval
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    const h = xs[hi] - xs[lo];
    const t = (x - xs[lo]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[lo] +
      (t3 - 2 * t2 + t) * h * ms[lo] +
      (-2 * t3 + 3 * t2) * ys[hi] +
      (t3 - t2) * h * ms[hi]
    );
  }
}

/** A 2D polyline with cumulative arc length, used for section curves. */
export class Polyline2 {
  readonly x: number[] = [];
  readonly y: number[] = [];
  readonly s: number[] = [];

  push(x: number, y: number): void {
    const n = this.x.length;
    if (n > 0) {
      const dx = x - this.x[n - 1];
      const dy = y - this.y[n - 1];
      const d = Math.hypot(dx, dy);
      if (d < 1e-7) return; // skip duplicates so arc-length stays strictly increasing
      this.s.push(this.s[n - 1] + d);
    } else {
      this.s.push(0);
    }
    this.x.push(x);
    this.y.push(y);
  }

  get length(): number {
    return this.s.length ? this.s[this.s.length - 1] : 0;
  }

  get count(): number {
    return this.x.length;
  }

  /** Point at arc length `s` (clamped). */
  at(s: number, out: { x: number; y: number }): { x: number; y: number } {
    const n = this.s.length;
    if (n === 0) {
      out.x = 0;
      out.y = 0;
      return out;
    }
    if (s <= 0 || n === 1) {
      out.x = this.x[0];
      out.y = this.y[0];
      return out;
    }
    if (s >= this.s[n - 1]) {
      out.x = this.x[n - 1];
      out.y = this.y[n - 1];
      return out;
    }
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.s[mid] <= s) lo = mid;
      else hi = mid;
    }
    const t = (s - this.s[lo]) / (this.s[hi] - this.s[lo]);
    out.x = this.x[lo] + (this.x[hi] - this.x[lo]) * t;
    out.y = this.y[lo] + (this.y[hi] - this.y[lo]) * t;
    return out;
  }

  /**
   * Arc length of the first crossing of the horizontal line `y` walking from the start.
   * Returns 0 if the start is already above `y`, the full length if never reached.
   */
  firstCrossingY(y: number): number {
    const n = this.x.length;
    if (n === 0) return 0;
    if (this.y[0] >= y) return 0;
    for (let i = 1; i < n; i++) {
      if (this.y[i] >= y) {
        const y0 = this.y[i - 1];
        const t = (y - y0) / (this.y[i] - y0);
        return this.s[i - 1] + (this.s[i] - this.s[i - 1]) * t;
      }
    }
    return this.length;
  }

  /** Largest x reached at height y (searches every segment straddling y). -Infinity if none. */
  maxXAtY(y: number): number {
    let best = -Infinity;
    for (let i = 1; i < this.x.length; i++) {
      const y0 = this.y[i - 1];
      const y1 = this.y[i];
      if ((y0 - y) * (y1 - y) <= 0 && y0 !== y1) {
        const t = (y - y0) / (y1 - y0);
        const x = this.x[i - 1] + (this.x[i] - this.x[i - 1]) * t;
        if (x > best) best = x;
      }
    }
    return best;
  }

  /** Largest y reached at lateral position x (searches every segment straddling x). -Infinity if none. */
  maxYAtX(x: number): number {
    let best = -Infinity;
    for (let i = 1; i < this.x.length; i++) {
      const x0 = this.x[i - 1];
      const x1 = this.x[i];
      if ((x0 - x) * (x1 - x) <= 0 && x0 !== x1) {
        const t = (x - x0) / (x1 - x0);
        const y = this.y[i - 1] + (this.y[i] - this.y[i - 1]) * t;
        if (y > best) best = y;
      }
    }
    return best;
  }
}

/**
 * Resample the part of `poly` between arc lengths s0..s1 into `count` points (inclusive endpoints),
 * appending [x, y] pairs to `out`. `bias` > 1 concentrates points towards s1, < 1 towards s0.
 */
export function resampleRange(
  poly: Polyline2,
  s0: number,
  s1: number,
  count: number,
  out: number[],
  bias = 1,
): void {
  const p = { x: 0, y: 0 };
  for (let k = 0; k < count; k++) {
    let t = count === 1 ? 0 : k / (count - 1);
    if (bias !== 1) t = 1 - Math.pow(1 - t, bias);
    poly.at(s0 + (s1 - s0) * t, p);
    out.push(p.x, p.y);
  }
}

/** Walk from zStart to zEnd with a variable step, then merge in extra breakpoints. */
export function buildStations(
  zStart: number,
  zEnd: number,
  spacing: (z: number) => number,
  extra: number[] = [],
  minGap = 0.0012,
): number[] {
  const zs: number[] = [zStart];
  let z = zStart;
  while (z < zEnd) {
    z += spacing(z);
    if (z >= zEnd - 0.25 * spacing(zEnd)) break;
    zs.push(z);
  }
  zs.push(zEnd);
  for (const e of extra) if (e > zStart && e < zEnd) zs.push(e);
  zs.sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of zs) {
    if (out.length === 0 || v - out[out.length - 1] > minGap) out.push(v);
    else if (v === zEnd) out[out.length - 1] = v;
  }
  return out;
}

/**
 * Resample poly[s0..s1] into `count` points, distributing them by arc length plus `beta` metres
 * of virtual length per radian of turning, so tight curves (fender rolls, lips) get more vertices.
 */
export function resampleWeighted(
  poly: Polyline2,
  s0: number,
  s1: number,
  count: number,
  out: number[],
  beta = 0.03,
): void {
  if (count <= 0) return;
  const p = { x: 0, y: 0 };
  if (s1 - s0 < 1e-6 || poly.count < 2) {
    poly.at(s0, p);
    for (let k = 0; k < count; k++) out.push(p.x, p.y);
    return;
  }
  // collect the sub-polyline
  const xs: number[] = [];
  const ys: number[] = [];
  poly.at(s0, p);
  xs.push(p.x);
  ys.push(p.y);
  for (let i = 0; i < poly.count; i++) {
    const s = poly.s[i];
    if (s > s0 + 1e-7 && s < s1 - 1e-7) {
      xs.push(poly.x[i]);
      ys.push(poly.y[i]);
    }
  }
  poly.at(s1, p);
  xs.push(p.x);
  ys.push(p.y);
  const n = xs.length;
  const len: number[] = [];
  const ang: number[] = [];
  for (let i = 0; i < n - 1; i++) len.push(Math.hypot(xs[i + 1] - xs[i], ys[i + 1] - ys[i]));
  for (let i = 0; i < n; i++) {
    if (i === 0 || i === n - 1) {
      ang.push(0);
      continue;
    }
    const a0 = Math.atan2(ys[i] - ys[i - 1], xs[i] - xs[i - 1]);
    const a1 = Math.atan2(ys[i + 1] - ys[i], xs[i + 1] - xs[i]);
    let d = a1 - a0;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    ang.push(Math.abs(d));
  }
  const cum: number[] = [0];
  for (let i = 0; i < n - 1; i++) cum.push(cum[i] + len[i] + beta * 0.5 * (ang[i] + ang[i + 1]));
  const total = cum[n - 1];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const target = count === 1 ? 0 : (total * k) / (count - 1);
    while (seg < n - 2 && cum[seg + 1] < target) seg++;
    const span = cum[seg + 1] - cum[seg];
    const t = span > 1e-9 ? clamp((target - cum[seg]) / span, 0, 1) : 0;
    out.push(xs[seg] + (xs[seg + 1] - xs[seg]) * t, ys[seg] + (ys[seg + 1] - ys[seg]) * t);
  }
}
