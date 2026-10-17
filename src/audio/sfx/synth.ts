/**
 * Synthesis primitives used by the one-shot sounds. Each primitive adds nodes to a Voice (so cleanup is
 * automatic), schedules everything sample-accurately from `t`, and returns its stop time.
 */
import { percEnv, sweep, swellEnv } from '../dsp/params';
import type { Voice } from '../dsp/voice';

/** Shared procedural material handed to synth routines. */
export interface NoiseBank {
  white: AudioBuffer;
  pink: AudioBuffer;
  brown: AudioBuffer;
  crackle: AudioBuffer;
}

export interface SynthKit {
  rng: () => number;
  noise: NoiseBank;
  /** Waveshaper curves: heavy crunch (crash / hard landing), light grit. */
  curves: { crunch: Float32Array<ArrayBuffer>; grit: Float32Array<ArrayBuffer> };
}

/** Where a primitive's output goes. */
export interface Dest {
  dry: AudioNode;
  /** Reverb send bus. */
  wet?: AudioNode;
  /** Send amount (0..1). */
  send?: number;
  /** Stereo position -1..1. */
  pan?: number;
}

/** Connect `node` to the destination (optional pan + reverb send). */
export function route(v: Voice, node: AudioNode, d: Dest): void {
  let out: AudioNode = node;
  if (d.pan) {
    const p = v.pan(d.pan);
    node.connect(p);
    out = p;
  }
  out.connect(d.dry);
  if (d.wet && d.send && d.send > 0) {
    const s = v.gain(d.send);
    out.connect(s);
    s.connect(d.wet);
  }
}

/** Random start offset into a looping noise buffer (decorrelates successive hits). */
const offsetIn = (kit: SynthKit, buf: AudioBuffer): number => kit.rng() * Math.max(0, buf.duration - 1);

export interface ThumpOpts {
  f0: number;
  f1: number;
  /** Pitch-drop time (s). */
  sweepTime: number;
  decay: number;
  gain: number;
  attack?: number;
  /** Waveform (default sine). A few odd harmonics keep low hits audible on small speakers. */
  type?: OscillatorType | PeriodicWave;
}

/** Pitched body hit: sine with an exponential pitch drop (kick / thud / boom). */
export function thump(v: Voice, d: Dest, t: number, o: ThumpOpts): number {
  const attack = o.attack ?? 0.002;
  const g = v.gain(0);
  const end = percEnv(g.gain, t, o.gain, attack, o.decay);
  const osc = v.osc(o.type ?? 'sine', o.f0, t, end);
  sweep(osc.frequency, o.f0, o.f1, t, o.sweepTime);
  osc.connect(g);
  route(v, g, d);
  return end;
}

export interface NoiseHitOpts {
  buffer: AudioBuffer;
  type: BiquadFilterType;
  freq: number;
  q?: number;
  /** Exponential filter sweep target (Hz) over `sweepTime`. */
  freqTo?: number;
  sweepTime?: number;
  /** Optional filter before the main one (e.g. a highpass in front of a bandpass). */
  pre?: { type: BiquadFilterType; freq: number; q?: number };
  /** Optional waveshaper after the filters (crunch / grit). */
  drive?: Float32Array<ArrayBuffer>;
  /** Gain into the waveshaper (drive amount). */
  driveGain?: number;
  attack?: number;
  decay: number;
  gain: number;
  /** Soft exponential attack ("swell") instead of a linear one. */
  swell?: boolean;
  /** Playback rate of the noise (changes its colour slightly). */
  rate?: number;
}

/** Filtered noise burst / swell / sweep. */
export function noiseHit(v: Voice, kit: SynthKit, d: Dest, t: number, o: NoiseHitOpts): number {
  const attack = o.attack ?? 0.003;
  const g = v.gain(0);
  const end = o.swell
    ? swellEnv(g.gain, t, o.gain, attack, t + attack, o.decay)
    : percEnv(g.gain, t, o.gain, attack, o.decay);
  const src = v.buffer(o.buffer, t, end, { rate: o.rate ?? 1, offset: offsetIn(kit, o.buffer) });
  let head: AudioNode = src;
  if (o.pre) {
    const pf = v.filter(o.pre.type, o.pre.freq, o.pre.q ?? 0.707);
    head.connect(pf);
    head = pf;
  }
  const f = v.filter(o.type, o.freq, o.q ?? 0.707);
  if (o.freqTo !== undefined) sweep(f.frequency, o.freq, o.freqTo, t, o.sweepTime ?? o.decay);
  head.connect(f);
  head = f;
  if (o.drive) {
    const pre = v.gain(o.driveGain ?? 2);
    const sh = v.shaper(o.drive);
    head.connect(pre);
    pre.connect(sh);
    head = sh;
  }
  head.connect(g);
  route(v, g, d);
  return end;
}

export interface PartialsOpts {
  freqs: readonly number[];
  decays: readonly number[];
  gains: readonly number[];
  /** Random frequency spread (fraction), e.g. 0.06 → ±6 %. */
  spread?: number;
  /** Global frequency multiplier. */
  pitch?: number;
  /** Overall gain multiplier. */
  gain?: number;
}

/** Inharmonic decaying sine partials — metallic clanks, latches, rattles, debris pings. */
export function partials(v: Voice, kit: SynthKit, d: Dest, t: number, o: PartialsOpts): number {
  const out = v.gain(o.gain ?? 1);
  let end = t;
  const pitch = o.pitch ?? 1;
  for (let i = 0; i < o.freqs.length; i++) {
    const f = o.freqs[i] * pitch * (1 + ((o.spread ?? 0) * (kit.rng() * 2 - 1)));
    const g = v.gain(0);
    const e = percEnv(g.gain, t, o.gains[i] ?? 0.05, 0.0015, o.decays[i] ?? 0.1);
    const osc = v.osc('sine', f, t, e);
    osc.connect(g);
    g.connect(out);
    end = Math.max(end, e);
  }
  route(v, out, d);
  return end;
}

export interface BellOpts {
  freq: number;
  /** Modulator / carrier ratio (2 → clean & harmonic, 3.5 → glassy bell). */
  ratio: number;
  /** Peak modulation index. */
  index: number;
  decay: number;
  gain: number;
  attack?: number;
  /** How fast the brightness decays relative to the amplitude (0..1, smaller = faster). */
  brightness?: number;
}

/** Two-operator FM bell / chime / glass pluck. */
export function fmBell(v: Voice, d: Dest, t: number, o: BellOpts): number {
  const attack = o.attack ?? 0.003;
  const g = v.gain(0);
  const end = percEnv(g.gain, t, o.gain, attack, o.decay);
  const car = v.osc('sine', o.freq, t, end);
  const mod = v.osc('sine', o.freq * o.ratio, t, end);
  const idx = v.gain(0);
  const depth = o.freq * o.index;
  idx.gain.setValueAtTime(depth, t);
  idx.gain.setTargetAtTime(depth * 0.08, t, o.decay * (o.brightness ?? 0.18));
  mod.connect(idx);
  idx.connect(car.frequency);
  car.connect(g);
  route(v, g, d);
  return end;
}

export interface ToneOpts {
  type: OscillatorType | PeriodicWave;
  freq: number;
  /** Optional exponential glide target. */
  freqTo?: number;
  glide?: number;
  attack?: number;
  decay: number;
  gain: number;
  /** Optional lowpass on the tone. */
  lowpass?: number;
}

/** Simple enveloped oscillator (UI blips, sub swells, chirps). */
export function tone(v: Voice, d: Dest, t: number, o: ToneOpts): number {
  const attack = o.attack ?? 0.003;
  const g = v.gain(0);
  const end = percEnv(g.gain, t, o.gain, attack, o.decay);
  const osc = v.osc(o.type, o.freq, t, end);
  if (o.freqTo !== undefined) sweep(osc.frequency, o.freq, o.freqTo, t, o.glide ?? o.decay);
  let head: AudioNode = osc;
  if (o.lowpass) {
    const f = v.filter('lowpass', o.lowpass, 0.7);
    osc.connect(f);
    head = f;
  }
  head.connect(g);
  route(v, g, d);
  return end;
}

/** Soft swelling sine (bass swell under the PERFECT chime, sub drops). */
export function swellTone(
  v: Voice,
  d: Dest,
  t: number,
  o: { type?: OscillatorType | PeriodicWave; freq: number; freqTo?: number; glide?: number; attack: number; hold: number; release: number; gain: number; lowpass?: number },
): number {
  const g = v.gain(0);
  const end = swellEnv(g.gain, t, o.gain, o.attack, t + o.attack + o.hold, o.release);
  const osc = v.osc(o.type ?? 'sine', o.freq, t, end);
  if (o.freqTo !== undefined) sweep(osc.frequency, o.freq, o.freqTo, t, o.glide ?? o.attack + o.hold);
  let head: AudioNode = osc;
  if (o.lowpass) {
    const f = v.filter('lowpass', o.lowpass, 0.7);
    osc.connect(f);
    head = f;
  }
  head.connect(g);
  route(v, g, d);
  return end;
}
