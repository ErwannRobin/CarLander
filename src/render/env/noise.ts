/**
 * Small, fast, seeded noise toolkit used at build time (procedural textures, landscape meshes,
 * cloud placement). Everything here is deterministic for a given seed and allocation-free in the
 * inner loops.
 *
 * - `mulberry32`        tiny seeded PRNG
 * - `Perlin2`           2D gradient noise with an optional integer period (tileable textures)
 * - `fbm`, `ridged`     fractal sums on top of a Perlin2 instance
 * - `worley2`           tileable F1 cellular noise (billowy cloud detail)
 */

/** Seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer hash -> [0, 1). */
export function hash2i(x: number, y: number, seed = 0): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * 2D Perlin gradient noise in [-1, 1] (approximately). With `period > 0` the lattice wraps every
 * `period` units, so noise(x + period, y) === noise(x, y) — used for seamless textures.
 */
export class Perlin2 {
  private readonly perm = new Uint16Array(512);
  private readonly gx = new Float32Array(256);
  private readonly gy = new Float32Array(256);

  constructor(seed = 1) {
    const rnd = mulberry32(seed);
    const p = new Uint16Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    for (let i = 0; i < 256; i++) {
      const a = rnd() * Math.PI * 2;
      this.gx[i] = Math.cos(a);
      this.gy[i] = Math.sin(a);
    }
  }

  noise(x: number, y: number, period = 0): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    let x0 = xi;
    let y0 = yi;
    let x1 = xi + 1;
    let y1 = yi + 1;
    if (period > 0) {
      x0 = ((x0 % period) + period) % period;
      y0 = ((y0 % period) + period) % period;
      x1 = ((x1 % period) + period) % period;
      y1 = ((y1 % period) + period) % period;
    }
    const perm = this.perm;
    const h00 = perm[(perm[x0 & 255] + y0) & 511];
    const h10 = perm[(perm[x1 & 255] + y0) & 511];
    const h01 = perm[(perm[x0 & 255] + y1) & 511];
    const h11 = perm[(perm[x1 & 255] + y1) & 511];
    const gx = this.gx;
    const gy = this.gy;
    const n00 = gx[h00] * xf + gy[h00] * yf;
    const n10 = gx[h10] * (xf - 1) + gy[h10] * yf;
    const n01 = gx[h01] * xf + gy[h01] * (yf - 1);
    const n11 = gx[h11] * (xf - 1) + gy[h11] * (yf - 1);
    const u = fade(xf);
    const v = fade(yf);
    const nx0 = n00 + u * (n10 - n00);
    const nx1 = n01 + u * (n11 - n01);
    // Perlin 2D range is about +-0.707; normalize to roughly +-1.
    return (nx0 + v * (nx1 - nx0)) * 1.4142;
  }
}

/** Fractal Brownian motion in [-1, 1] (approximately). Period doubles with each octave when tiling. */
export function fbm(
  n: Perlin2,
  x: number,
  y: number,
  octaves: number,
  period = 0,
  lacunarity = 2,
  gain = 0.5,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  let p = period;
  for (let o = 0; o < octaves; o++) {
    sum += amp * n.noise(x * f, y * f, p);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
    if (p > 0) p *= lacunarity;
  }
  return sum / norm;
}

/**
 * Ridged multifractal in [0, 1]: sharp crests (mountain ridgelines). Each octave is weighted by the
 * previous one so detail accumulates on the ridges and valleys stay smooth.
 */
export function ridged(n: Perlin2, x: number, y: number, octaves: number, lacunarity = 2.03, gain = 0.5): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  let weight = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    let s = 1 - Math.abs(n.noise(x * f + o * 17.13, y * f - o * 9.71));
    s *= s;
    s *= weight;
    weight = Math.min(1, Math.max(0, s * 2));
    sum += s * amp;
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

/**
 * Tileable Worley F1 noise: distance to the nearest feature point, normalized so that the result is
 * in [0, ~1]. `cells` feature cells per unit (the domain [0,1) tiles seamlessly).
 */
export function worley2(u: number, v: number, cells: number, seed: number): number {
  const x = u * cells;
  const y = v * cells;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let best = 8;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = xi + ox;
      const cy = yi + oy;
      const wx = ((cx % cells) + cells) % cells;
      const wy = ((cy % cells) + cells) % cells;
      const px = cx + hash2i(wx, wy, seed);
      const py = cy + hash2i(wx, wy, seed + 101);
      const dx = px - x;
      const dy = py - y;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return Math.min(1, Math.sqrt(best));
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
