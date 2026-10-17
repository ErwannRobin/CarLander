/**
 * Offline signal analysis for the audio self-test: peak, active RMS, spectral centroid and band energy
 * split (Welch-averaged Hann FFTs). Pure functions over AudioBuffers — dev tooling, not shipped in the
 * game graph.
 */

export interface Bands {
  /** < 80 Hz */
  sub: number;
  /** 80–300 Hz */
  low: number;
  /** 300–2000 Hz */
  mid: number;
  /** 2–6 kHz (ear's most sensitive / harshness region) */
  high: number;
  /** > 6 kHz */
  air: number;
}

export interface Metrics {
  /** Max |sample| over all channels. */
  peak: number;
  /** ITU-R BS.1770 momentary loudness maximum (400 ms window), LUFS — "how loud does it feel". */
  lufsM: number;
  /** ITU-R BS.1770-4 gated integrated loudness, LUFS. */
  lufsI: number;
  /** Transient loudness: K-weighted maximum over 100 ms windows (tracks short hits better), LUFS. */
  lufsT: number;
  /** Transient loudness through a simulated laptop speaker (4th-order 200 Hz high-pass), LUFS. */
  lufsSmall: number;
  /** RMS (dBFS) over active 10 ms blocks only (meaningful for short sounds). */
  rmsDb: number;
  /** Total duration of 10 ms blocks above -50 dBFS. */
  activeMs: number;
  /** Power-weighted mean frequency (Hz). */
  centroidHz: number;
  /** Fraction of spectral energy per band (sums to 1). */
  bands: Bands;
}

const N = 4096;
const HOP = 2048;
let hann: Float64Array | null = null;

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

const toDb = (x: number): number => (x <= 1e-9 ? -180 : 20 * Math.log10(x));

/** Mono mix (average of channels) of [from, to) seconds. */
function mono(buf: AudioBuffer, from: number, to: number): Float32Array {
  const sr = buf.sampleRate;
  const a = Math.max(0, Math.floor(from * sr));
  const b = Math.min(buf.length, Math.floor(to * sr));
  const out = new Float32Array(Math.max(0, b - a));
  const chs = buf.numberOfChannels;
  for (let c = 0; c < chs; c++) {
    const d = buf.getChannelData(c);
    for (let i = a; i < b; i++) out[i - a] += d[i] / chs;
  }
  return out;
}

export function peakOf(buf: AudioBuffer, from = 0, to = buf.duration): number {
  const sr = buf.sampleRate;
  const a = Math.max(0, Math.floor(from * sr));
  const b = Math.min(buf.length, Math.floor(to * sr));
  let p = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = a; i < b; i++) {
      const v = Math.abs(d[i]);
      if (v > p) p = v;
    }
  }
  return p;
}

/** Plain RMS (dBFS) over a window, all channels. */
export function rmsDbOf(buf: AudioBuffer, from = 0, to = buf.duration): number {
  const sr = buf.sampleRate;
  const a = Math.max(0, Math.floor(from * sr));
  const b = Math.min(buf.length, Math.floor(to * sr));
  let sq = 0;
  let n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = a; i < b; i++) sq += d[i] * d[i];
    n += Math.max(0, b - a);
  }
  return toDb(Math.sqrt(sq / Math.max(1, n)));
}

/** Spectral centroid + bands over a window (Welch average of active frames). */
export function spectrumOf(buf: AudioBuffer, from = 0, to = buf.duration): { centroidHz: number; bands: Bands } {
  const x = mono(buf, from, to);
  const sr = buf.sampleRate;
  if (!hann) {
    hann = new Float64Array(N);
    for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  }
  const power = new Float64Array(N / 2);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let frames = 0;
  for (let start = 0; start + N <= Math.max(N, x.length); start += HOP) {
    let e = 0;
    for (let i = 0; i < N; i++) {
      const v = start + i < x.length ? x[start + i] : 0;
      re[i] = v * hann[i];
      im[i] = 0;
      e += v * v;
    }
    if (Math.sqrt(e / N) < 1e-3) continue; // skip near-silent frames (< -60 dBFS)
    fft(re, im);
    for (let k = 0; k < N / 2; k++) power[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
    if (x.length < N) break;
  }
  const bands: Bands = { sub: 0, low: 0, mid: 0, high: 0, air: 0 };
  if (frames === 0) return { centroidHz: 0, bands };
  let total = 0;
  let weighted = 0;
  for (let k = 1; k < N / 2; k++) {
    const f = (k * sr) / N;
    if (f < 20 || f > 20000) continue;
    const p = power[k];
    total += p;
    weighted += f * p;
    if (f < 80) bands.sub += p;
    else if (f < 300) bands.low += p;
    else if (f < 2000) bands.mid += p;
    else if (f < 6000) bands.high += p;
    else bands.air += p;
  }
  if (total <= 0) return { centroidHz: 0, bands };
  bands.sub /= total;
  bands.low /= total;
  bands.mid /= total;
  bands.high /= total;
  bands.air /= total;
  return { centroidHz: weighted / total, bands };
}

/* ---------------------------------------------------------------- */
/* ITU-R BS.1770 loudness                                            */
/* ---------------------------------------------------------------- */

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** K-weighting filter pair (pre-filter shelf + RLB high-pass) for any sample rate (libebur128 formulas). */
function kWeightCoeffs(fs: number): [Biquad, Biquad] {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  const hp: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, hp];
}

function biquad(x: Float64Array, c: Biquad): void {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    x[i] = y0;
  }
}

const lufs = (power: number): number => (power <= 1e-12 ? -120 : -0.691 + 10 * Math.log10(power));

/** RBJ high-pass biquad. */
function highpassCoeffs(fs: number, f0: number, q: number): Biquad {
  const w0 = (2 * Math.PI * f0) / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const c = Math.cos(w0);
  const a0 = 1 + alpha;
  return { b0: (1 + c) / 2 / a0, b1: -(1 + c) / a0, b2: (1 + c) / 2 / a0, a1: (-2 * c) / a0, a2: (1 - alpha) / a0 };
}

/**
 * Momentary-max and gated integrated loudness over [from, to).
 * `smallSpeaker` first applies a 4th-order 200 Hz high-pass (typical laptop / phone speaker roll-off).
 */
export function loudnessOf(
  buf: AudioBuffer,
  from = 0,
  to = buf.duration,
  smallSpeaker = false,
  /** Window for the "momentary" maximum: 0.4 s per BS.1770; 0.1 s tracks short transients better. */
  window = 0.4,
): { momentaryMax: number; integrated: number } {
  const sr = buf.sampleRate;
  const a = Math.max(0, Math.floor(from * sr));
  const b = Math.min(buf.length, Math.floor(to * sr));
  const n = Math.max(0, b - a);
  const [shelf, hp] = kWeightCoeffs(sr);
  const speaker = highpassCoeffs(sr, 200, 0.7071);
  // Per-sample sum over channels of the K-weighted signal squared.
  const sq = new Float64Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    const z = new Float64Array(n);
    for (let i = 0; i < n; i++) z[i] = d[a + i];
    if (smallSpeaker) {
      biquad(z, speaker);
      biquad(z, speaker);
    }
    biquad(z, shelf);
    biquad(z, hp);
    for (let i = 0; i < n; i++) sq[i] += z[i] * z[i];
  }
  const win = Math.floor(window * sr);
  const hop = Math.floor(Math.min(0.1, window / 4) * sr);
  // Prefix sums → O(1) window power.
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + sq[i];
  const blocks: number[] = [];
  if (n <= win) blocks.push(pre[n] / win);
  else for (let s = 0; s + win <= n; s += hop) blocks.push((pre[s + win] - pre[s]) / win);
  let momentaryMax = -120;
  for (const p of blocks) momentaryMax = Math.max(momentaryMax, lufs(p));
  // BS.1770-4 gating: absolute -70 LUFS, then relative -10 LU.
  const abs = blocks.filter((p) => lufs(p) > -70);
  if (abs.length === 0) return { momentaryMax, integrated: -120 };
  const meanAbs = abs.reduce((s, p) => s + p, 0) / abs.length;
  const rel = abs.filter((p) => lufs(p) > lufs(meanAbs) - 10);
  const meanRel = rel.reduce((s, p) => s + p, 0) / Math.max(1, rel.length);
  return { momentaryMax, integrated: lufs(meanRel) };
}

/**
 * Click / discontinuity detector. Energy above ~10 kHz is measured in 1 ms blocks; a click is a block
 * whose HF RMS exceeds the median of the surrounding ±40 ms by more than `ratioDb` and an absolute floor.
 * Smooth envelopes and steady noise never trigger it; discontinuities (hard stops, jumps) do.
 */
export function clicksOf(buf: AudioBuffer, from = 0, to = buf.duration, ratioDb = 20): { count: number; worstDb: number; times: number[] } {
  const sr = buf.sampleRate;
  // Run the filter from 20 ms before the window so its start-up transient is not mistaken for a click.
  const lead = Math.min(from, 0.02);
  const x = mono(buf, from - lead, to);
  const z = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) z[i] = x[i];
  const hp = highpassCoeffs(sr, 10000, 0.7071);
  biquad(z, hp);
  biquad(z, hp);
  const skip = Math.floor(lead * sr);
  const bs = Math.max(1, Math.floor(sr / 1000));
  const nb = Math.floor((z.length - skip) / bs);
  const rms = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    let s = 0;
    for (let i = skip + b * bs; i < skip + (b + 1) * bs; i++) s += z[i] * z[i];
    rms[b] = Math.sqrt(s / bs);
  }
  const half = 40;
  const ratio = Math.pow(10, ratioDb / 20);
  const floor = 0.0005; // ≈ -66 dBFS
  const win: number[] = [];
  const times: number[] = [];
  let count = 0;
  let worst = 0;
  let lastClick = -100;
  for (let b = 0; b < nb; b++) {
    win.length = 0;
    for (let k = Math.max(0, b - half); k < Math.min(nb, b + half + 1); k++) if (k !== b) win.push(rms[k]);
    win.sort((p, q) => p - q);
    const med = win.length ? win[win.length >> 1] : 0;
    const r = rms[b] / Math.max(med, floor / ratio);
    if (rms[b] > floor && r > ratio) {
      if (b - lastClick > 5) {
        count++;
        if (times.length < 16) times.push(from + (b * bs) / sr);
      }
      lastClick = b;
    }
    if (rms[b] > floor) worst = Math.max(worst, r);
  }
  return { count, worstDb: worst > 0 ? 20 * Math.log10(worst) : -120, times };
}

/**
 * Energy (dBFS) of the mono mix below `cutoffHz` (2nd-order low-pass) over [from, to). The filter runs
 * from 0.1 s before the window so its start-up does not bias short windows. Tracks "thud" content.
 */
export function lowBandDbOf(buf: AudioBuffer, from: number, to: number, cutoffHz = 300): number {
  const sr = buf.sampleRate;
  const lead = Math.min(from, 0.1);
  const x = mono(buf, from - lead, to);
  const z = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) z[i] = x[i];
  const w0 = (2 * Math.PI * cutoffHz) / sr;
  const alpha = Math.sin(w0) / (2 * 0.7071);
  const c = Math.cos(w0);
  const a0 = 1 + alpha;
  biquad(z, { b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0, a1: (-2 * c) / a0, a2: (1 - alpha) / a0 });
  const skip = Math.floor(lead * sr);
  let sq = 0;
  for (let i = skip; i < z.length; i++) sq += z[i] * z[i];
  return 10 * Math.log10(sq / Math.max(1, z.length - skip) + 1e-20);
}

/**
 * Strongest frequency (Hz) between `lo` and `hi` over [from, to): a DFT scan in 1/48-octave steps on the
 * mono mix (2× decimated — fine below ~6 kHz). Used to follow the pitch of tonal one-shots (dings).
 */
export function dominantHzOf(buf: AudioBuffer, from: number, to: number, lo = 200, hi = 4000): number {
  const x = mono(buf, from, to);
  const sr = buf.sampleRate;
  let best = 0;
  let bestF = 0;
  for (let f = lo; f <= hi; f *= Math.pow(2, 1 / 48)) {
    const w = (2 * Math.PI * f) / sr;
    let re = 0;
    let im = 0;
    for (let i = 0; i < x.length; i += 2) {
      re += x[i] * Math.cos(w * i);
      im += x[i] * Math.sin(w * i);
    }
    const p = re * re + im * im;
    if (p > best) {
      best = p;
      bestF = f;
    }
  }
  return bestF;
}

/**
 * Envelope steadiness: 10th / 90th percentile of the block RMS (dB, `blockMs` blocks) over [from, to).
 * A continuous texture has a small spread; periodic pulses or repeated hits a large one.
 */
export function envelopeSpreadOf(buf: AudioBuffer, from: number, to: number, blockMs = 25): { p10: number; p90: number; spread: number } {
  const x = mono(buf, from, to);
  const bs = Math.max(1, Math.floor((blockMs / 1000) * buf.sampleRate));
  const vals: number[] = [];
  for (let s = 0; s + bs <= x.length; s += bs) {
    let q = 0;
    for (let i = s; i < s + bs; i++) q += x[i] * x[i];
    vals.push(10 * Math.log10(q / bs + 1e-20));
  }
  if (vals.length === 0) return { p10: -200, p90: -200, spread: 0 };
  vals.sort((p, q) => p - q);
  const p10 = vals[Math.floor(vals.length * 0.1)];
  const p90 = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.9))];
  return { p10, p90, spread: p90 - p10 };
}

/** Full metrics over a window. */
export function analyze(buf: AudioBuffer, from = 0, to = buf.duration): Metrics {
  const sr = buf.sampleRate;
  const block = Math.floor(0.01 * sr);
  const a = Math.max(0, Math.floor(from * sr));
  const b = Math.min(buf.length, Math.floor(to * sr));
  const chs = buf.numberOfChannels;
  let activeBlocks = 0;
  let activeSq = 0;
  let activeN = 0;
  for (let s = a; s < b; s += block) {
    const e = Math.min(b, s + block);
    let sq = 0;
    for (let c = 0; c < chs; c++) {
      const d = buf.getChannelData(c);
      for (let i = s; i < e; i++) sq += d[i] * d[i];
    }
    const n = (e - s) * chs;
    if (Math.sqrt(sq / Math.max(1, n)) > 0.00316) {
      activeBlocks++;
      activeSq += sq;
      activeN += n;
    }
  }
  const spec = spectrumOf(buf, from, to);
  const loud = loudnessOf(buf, from, to);
  return {
    peak: peakOf(buf, from, to),
    lufsM: loud.momentaryMax,
    lufsI: loud.integrated,
    lufsT: loudnessOf(buf, from, to, false, 0.1).momentaryMax,
    lufsSmall: loudnessOf(buf, from, to, true, 0.1).momentaryMax,
    rmsDb: activeN > 0 ? toDb(Math.sqrt(activeSq / activeN)) : -180,
    activeMs: activeBlocks * 10,
    centroidHz: spec.centroidHz,
    bands: spec.bands,
  };
}
