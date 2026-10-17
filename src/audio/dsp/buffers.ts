/**
 * Procedurally generated audio buffers & curves (no sample files anywhere).
 *
 * Buffers are cached per (kind, sample rate): the Web Audio spec allows one AudioBuffer to be shared by
 * several contexts (live + offline self-test), so generation cost is paid once.
 */
import { createRng } from './math';

const cache = new Map<string, AudioBuffer>();

function cached(ctx: BaseAudioContext, key: string, make: () => AudioBuffer): AudioBuffer {
  const k = `${key}@${ctx.sampleRate}`;
  let b = cache.get(k);
  if (!b) {
    b = make();
    cache.set(k, b);
  }
  return b;
}

/** Drop cached buffers (called by audio.dispose()). */
export function clearBufferCache(): void {
  cache.clear();
}

export type NoiseColor = 'white' | 'pink' | 'brown';

/** RMS every noise buffer is normalised to (≈ -12 dBFS) so layer gains are predictable. */
export const NOISE_RMS = 0.25;

/**
 * Seamlessly looping stereo noise (channels decorrelated). The loop seam is crossfaded with the
 * continuation of the sequence, so even low-frequency (brown) noise has no click at the loop point.
 */
export function noiseBuffer(ctx: BaseAudioContext, color: NoiseColor, seconds: number, seed = 1): AudioBuffer {
  return cached(ctx, `noise:${color}:${seconds}:${seed}`, () => {
    const sr = ctx.sampleRate;
    const n = Math.max(1, Math.floor(seconds * sr));
    const fade = Math.min(Math.floor(0.08 * sr), n >> 2);
    const buf = ctx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const rng = createRng(seed * 7919 + ch * 104729 + 17);
      const raw = new Float32Array(n + fade);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, brown = 0;
      for (let i = 0; i < raw.length; i++) {
        const w = rng() * 2 - 1;
        if (color === 'white') {
          raw[i] = w;
        } else if (color === 'pink') {
          // Paul Kellet's refined pink filter (−3 dB/oct).
          b0 = 0.99886 * b0 + w * 0.0555179;
          b1 = 0.99332 * b1 + w * 0.0750759;
          b2 = 0.969 * b2 + w * 0.153852;
          b3 = 0.8665 * b3 + w * 0.3104856;
          b4 = 0.55 * b4 + w * 0.5329522;
          b5 = -0.7616 * b5 - w * 0.016898;
          raw[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
          b6 = w * 0.115926;
        } else {
          // Leaky integrator (−6 dB/oct) — rumble / wind body.
          brown = (brown + 0.02 * w) / 1.02;
          raw[i] = brown;
        }
      }
      // Remove DC, then normalise RMS.
      let mean = 0;
      for (let i = 0; i < raw.length; i++) mean += raw[i];
      mean /= raw.length;
      let sq = 0;
      for (let i = 0; i < raw.length; i++) {
        raw[i] -= mean;
        sq += raw[i] * raw[i];
      }
      const scale = NOISE_RMS / Math.sqrt(sq / raw.length || 1);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = raw[i] * scale;
      // Loop crossfade: the head blends from the sequence's continuation (raw[n + i]) into itself.
      for (let i = 0; i < fade; i++) {
        const a = i / fade;
        out[i] = (raw[i] * a + raw[n + i] * (1 - a)) * scale;
      }
      for (let i = 0; i < n; i++) out[i] = Math.max(-1, Math.min(1, out[i]));
      buf.copyToChannel(out, ch);
    }
    return buf;
  });
}

/**
 * Rocket "crackle": sparse, power-law distributed micro-bursts (few big pops, many small ticks).
 * Loops cleanly because no burst straddles the loop point.
 */
export function crackleBuffer(ctx: BaseAudioContext, seconds = 3, seed = 3): AudioBuffer {
  return cached(ctx, `crackle:${seconds}:${seed}`, () => {
    const sr = ctx.sampleRate;
    const n = Math.floor(seconds * sr);
    const buf = ctx.createBuffer(2, n, sr);
    const ratePerSec = 85;
    for (let ch = 0; ch < 2; ch++) {
      const rng = createRng(seed * 3571 + ch * 131);
      const data = new Float32Array(n);
      let pos = 0;
      for (;;) {
        pos += Math.floor((-Math.log(1 - rng()) / ratePerSec) * sr); // Poisson arrivals
        const decay = (0.0006 + rng() * 0.0032) * sr;
        const len = Math.floor(decay * 7);
        if (pos + len >= n) break;
        const amp = (0.12 + 0.88 * Math.pow(rng(), 3)) * (rng() < 0.5 ? -1 : 1);
        for (let i = 0; i < len; i++) {
          const e = Math.exp(-i / decay);
          // Initial impulse plus a short noisy tail → "crack" rather than a dull click.
          data[pos + i] += amp * e * (i === 0 ? 1 : (rng() * 2 - 1) * 0.75);
        }
      }
      let peak = 0;
      for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(data[i]));
      const s = peak > 0 ? 0.95 / peak : 1;
      for (let i = 0; i < n; i++) data[i] *= s;
      buf.copyToChannel(data, ch);
    }
    return buf;
  });
}

/**
 * Stereo reverb impulse response: pre-delay, a handful of early reflections, then a diffuse tail whose
 * brightness decays faster than its level (air absorption) — a large, soft hall. Used with
 * ConvolverNode.normalize = true, so absolute scale does not matter.
 */
export function impulseResponse(ctx: BaseAudioContext, seconds = 2.4, rt60 = 2.2, seed = 5): AudioBuffer {
  return cached(ctx, `ir:${seconds}:${rt60}:${seed}`, () => {
    const sr = ctx.sampleRate;
    const n = Math.floor(seconds * sr);
    const pre = Math.floor(0.014 * sr);
    const buf = ctx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const rng = createRng(seed * 9973 + ch * 7);
      const data = new Float32Array(n);
      let lp = 0;
      for (let i = pre; i < n; i++) {
        const t = (i - pre) / sr;
        const env = Math.exp((-6.9 * t) / rt60) * (1 - Math.exp(-t / 0.006));
        const cutoff = 1400 + 9000 * Math.exp(-t * 1.7);
        const a = 1 - Math.exp((-2 * Math.PI * cutoff) / sr);
        lp += a * (rng() * 2 - 1 - lp);
        data[i] = lp * env;
      }
      // Early reflections (different per channel → width).
      for (let k = 0; k < 9; k++) {
        const time = 0.008 + rng() * 0.075;
        const idx = pre + Math.floor(time * sr);
        if (idx < n) data[idx] += (rng() < 0.5 ? -1 : 1) * (0.5 - k * 0.04) * (1 - time * 4);
      }
      // Fade the very end to zero.
      const tail = Math.floor(0.05 * sr);
      for (let i = 0; i < tail; i++) data[n - 1 - i] *= i / tail;
      buf.copyToChannel(data, ch);
    }
    return buf;
  });
}

/**
 * Transparent-below-knee soft limiter curve for a WaveShaperNode. The curve spans input [-range, range]
 * (feed it through a gain of 1/range); output never exceeds `ceiling`.
 */
export function softClipCurve(n = 4096, knee = 0.62, ceiling = 0.955, range = 2): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  const span = ceiling - knee;
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * range;
    const ax = Math.abs(x);
    const y = ax <= knee ? ax : knee + span * Math.tanh((ax - knee) / span);
    c[i] = Math.sign(x) * y;
  }
  return c;
}

/** Symmetric tanh drive curve normalised to ±1 (crunch / grit). */
export function driveCurve(drive: number, n = 2048): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(drive * x) / norm;
  }
  return c;
}

/** Periodic wave with sine partial amplitudes `harmonics[k]` for harmonic k+1. */
export function harmonicWave(ctx: BaseAudioContext, harmonics: readonly number[]): PeriodicWave {
  const real = new Float32Array(harmonics.length + 1);
  const imag = new Float32Array(harmonics.length + 1);
  for (let k = 0; k < harmonics.length; k++) imag[k + 1] = harmonics[k];
  return ctx.createPeriodicWave(real, imag);
}

/** "Soft saw": 1/n^p partial roll-off — warmer than a sawtooth and far less aliasing up top. */
export function softSawWave(ctx: BaseAudioContext, partials = 28, p = 1.3): PeriodicWave {
  const h: number[] = [];
  for (let k = 1; k <= partials; k++) h.push(1 / Math.pow(k, p));
  return harmonicWave(ctx, h);
}
