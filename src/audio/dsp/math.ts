/** Small numeric helpers shared by the audio module (allocation-free). */

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** `x` if finite, else `fallback` — sim values feed AudioParams, which throw on NaN/Infinity. */
export const fin = (x: number, fallback = 0): number => (Number.isFinite(x) ? x : fallback);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export const dbToGain = (db: number): number => Math.pow(10, db / 20);

export const gainToDb = (g: number): number => (g <= 1e-9 ? -180 : 20 * Math.log10(g));

/** Equal-tempered MIDI note number → Hz (A4 = 69 = 440 Hz). */
export const midiToHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

/** Frame-rate independent exponential smoothing coefficient for time constant `tau` (s). */
export const smoothK = (dt: number, tau: number): number => (tau <= 0 ? 1 : 1 - Math.exp(-dt / tau));

/** Perceptual slider value 0..1 → linear gain (audio taper approximation). */
export const sliderToGain = (v: number): number => {
  const c = clamp(Number.isFinite(v) ? v : 0, 0, 1);
  return c * c;
};

/** Seeded PRNG (mulberry32). Returns floats in [0, 1). Deterministic noise buffers & one-shot variation. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bounded random walk in [-1, 1] — used for organic modulation (wind gusts, squeal flutter, rumble
 * jitter) without oscillators. `rate` ≈ how fast it wanders (1/s), `pull` re-centres it.
 */
export class Wander {
  value = 0;
  private vel = 0;
  constructor(
    private readonly rng: () => number,
    private readonly rate: number,
    private readonly pull = 1.5,
  ) {}
  step(dt: number): number {
    const kick = (this.rng() * 2 - 1) * this.rate;
    this.vel += (kick - this.vel * 4 - this.value * this.pull) * dt * 6;
    this.value = clamp(this.value + this.vel * dt, -1, 1);
    return this.value;
  }
}
