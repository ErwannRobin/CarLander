/**
 * Music instruments. Each call schedules one note into a self-cleaning voice from the music pool.
 * Sustained instruments (pads, sub) return a `Sustain` handle that is released at the next chord change.
 */
import { midiToHz } from '../dsp/math';
import { kRate, percEnv } from '../dsp/params';
import type { Voice, VoicePool } from '../dsp/voice';
import type { NoiseBank } from '../sfx/synth';

export interface MusicKit {
  ctx: BaseAudioContext;
  pool: VoicePool;
  rng: () => number;
  noise: NoiseBank;
  softSaw: PeriodicWave;
  /** Kick body waveform: sine + a touch of 3rd/5th harmonic (audible on small speakers). */
  kickWave: PeriodicWave;
  /** Slow modulation source (in cents) applied to pad filter detune. */
  padLfo: AudioNode;
  /** Echo send input (dotted-eighth ping-pong). */
  delay: AudioNode;
  /** Reverb send bus. */
  wet: AudioNode;
}

/** Sustained voice released later (pads / sub). */
export class Sustain {
  constructor(
    readonly voice: Voice,
    private readonly env: GainNode,
    readonly filter: BiquadFilterNode | null,
    private readonly releaseTime: number,
  ) {}

  release(t: number, releaseTime = this.releaseTime): void {
    const v = this.voice;
    if (v.isFinished) return;
    if (t <= v.startTime) {
      v.cancel();
      return;
    }
    const p = this.env.gain;
    p.cancelScheduledValues(t);
    p.setTargetAtTime(0, t, releaseTime / 4.6);
    v.stopAll(t + releaseTime * 1.5 + 0.05);
  }
}

const noiseOffset = (k: MusicKit, buf: AudioBuffer) => k.rng() * Math.max(0, buf.duration - 1);

function send(v: Voice, from: AudioNode, to: AudioNode, amount: number): void {
  if (amount <= 0) return;
  const s = v.gain(amount);
  from.connect(s);
  s.connect(to);
}

export interface PadOpts {
  out: AudioNode;
  level: number;
  cutoff: number;
  attack: number;
  release: number;
  /** Reverb send. */
  send: number;
  wave: PeriodicWave | OscillatorType;
  /** Detune between the left/right oscillator of each note (cents, ±). */
  detune: number;
  /** Stereo spread of the detuned pair. */
  spread: number;
  /** Connect the shared slow filter LFO. */
  lfo: boolean;
  /** Optional shared vibrato source (cents) connected to every oscillator's detune. */
  vibrato?: AudioNode;
}

/** Warm stereo pad: per note two detuned oscillators panned apart, one lowpass + envelope per chord. */
export function pad(k: MusicKit, t: number, notes: readonly number[], o: PadOpts): Sustain | null {
  const v = k.pool.acquire(t, 2);
  if (!v) return null;
  const filt = v.filter('lowpass', o.cutoff, 0.5);
  kRate(filt.frequency);
  kRate(filt.detune);
  if (o.lfo) {
    k.padLfo.connect(filt.detune);
    v.onFinish(() => {
      try {
        k.padLfo.disconnect(filt.detune);
      } catch {
        /* already gone */
      }
    });
  }
  const env = v.gain(0);
  env.gain.setValueAtTime(0, t);
  env.gain.setTargetAtTime(o.level, t, o.attack / 3);
  const left = v.pan(-o.spread);
  const right = v.pan(o.spread);
  left.connect(filt);
  right.connect(filt);
  filt.connect(env);
  env.connect(o.out);
  send(v, env, k.wet, o.send);
  const vib = o.vibrato;
  for (const m of notes) {
    const f = midiToHz(m);
    const a = v.osc(o.wave, f, t, Infinity, -o.detune);
    const b = v.osc(o.wave, f, t, Infinity, o.detune);
    a.connect(left);
    b.connect(right);
    if (vib) {
      kRate(a.detune);
      kRate(b.detune);
      vib.connect(a.detune);
      vib.connect(b.detune);
      v.onFinish(() => {
        try {
          vib.disconnect(a.detune);
          vib.disconnect(b.detune);
        } catch {
          /* already gone */
        }
      });
    }
  }
  return new Sustain(v, env, filt, o.release);
}

/** Deep sustained sub (title / complete): sine root + quiet octave triangle, lowpassed. */
export function sub(k: MusicKit, t: number, midi: number, level: number, attack: number, release: number, out: AudioNode): Sustain | null {
  const v = k.pool.acquire(t, 2);
  if (!v) return null;
  const f = midiToHz(midi);
  const lp = v.filter('lowpass', 320, 0.7);
  const env = v.gain(0);
  env.gain.setValueAtTime(0, t);
  env.gain.setTargetAtTime(level, t, attack / 3);
  v.osc('sine', f, t, Infinity).connect(lp);
  const octG = v.gain(0.22);
  v.osc('triangle', f * 2, t, Infinity).connect(octG);
  octG.connect(lp);
  lp.connect(env);
  env.connect(out);
  return new Sustain(v, env, lp, release);
}

/** Soft pulse bass: soft-saw through a plucked lowpass + sine sub an octave below. */
export function bass(k: MusicKit, t: number, midi: number, dur: number, vel: number, bright: number, out: AudioNode): void {
  const v = k.pool.acquire(t, 1);
  if (!v) return;
  const f = midiToHz(midi);
  const end = t + dur + 0.25;
  const osc = v.osc(k.softSaw, f, t, end);
  const subOsc = v.osc('sine', f / 2, t, end);
  const subG = v.gain(0.4);
  const filt = v.filter('lowpass', 200, 2);
  filt.frequency.setValueAtTime(220 + 1400 * bright, t);
  filt.frequency.setTargetAtTime(150 + 260 * bright, t + 0.004, 0.07);
  const env = v.gain(0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(vel, t + 0.006);
  env.gain.setTargetAtTime(vel * 0.62, t + 0.006, 0.09);
  env.gain.setTargetAtTime(0, t + dur, 0.035);
  osc.connect(filt);
  filt.connect(env);
  subOsc.connect(subG);
  subG.connect(env);
  env.connect(out);
}

/** Round, soft kick (sine with pitch drop + tiny beater click). */
export function kick(k: MusicKit, t: number, vel: number, out: AudioNode): void {
  const v = k.pool.acquire(t, 1);
  if (!v) return;
  const g = v.gain(0);
  const end = percEnv(g.gain, t, vel, 0.002, 0.32);
  const o = v.osc(k.kickWave, 125, t, end);
  o.frequency.setValueAtTime(125, t);
  o.frequency.exponentialRampToValueAtTime(46, t + 0.1);
  o.connect(g);
  g.connect(out);
  const cg = v.gain(0);
  const cend = percEnv(cg.gain, t, vel * 0.18, 0.0008, 0.012);
  const n = v.buffer(k.noise.white, t, cend, { offset: noiseOffset(k, k.noise.white) });
  const lp = v.filter('lowpass', 2600, 0.7);
  n.connect(lp);
  lp.connect(cg);
  cg.connect(out);
}

/** Closed / open hat: highpassed noise with a gentle presence bump, slightly right of centre. */
export function hat(k: MusicKit, t: number, vel: number, open: boolean, out: AudioNode): void {
  const v = k.pool.acquire(t, 0);
  if (!v) return;
  const g = v.gain(0);
  const end = percEnv(g.gain, t, vel, 0.001, open ? 0.32 : 0.05);
  const n = v.buffer(k.noise.white, t, end, { offset: noiseOffset(k, k.noise.white) });
  const hp = v.filter('highpass', 7200, 0.8);
  const pk = v.filter('peaking', 10500, 1.2, 3);
  const p = v.pan(0.22);
  n.connect(hp);
  hp.connect(pk);
  pk.connect(g);
  g.connect(p);
  p.connect(out);
}

/** Soft roomy clap: three quick noise bursts + tail, mostly heard through the reverb. */
export function clap(k: MusicKit, t: number, vel: number, out: AudioNode): void {
  const v = k.pool.acquire(t, 1);
  if (!v) return;
  const g = v.gain(0);
  const p = g.gain;
  p.setValueAtTime(0, t);
  for (const dt of [0, 0.011, 0.022]) {
    p.setValueAtTime(vel, t + dt);
    p.setTargetAtTime(vel * 0.2, t + dt + 0.0005, 0.004);
  }
  p.setValueAtTime(vel * 0.85, t + 0.032);
  p.setTargetAtTime(0, t + 0.033, 0.045);
  const end = t + 0.36;
  const n = v.buffer(k.noise.white, t, end, { offset: noiseOffset(k, k.noise.white) });
  const bp = v.filter('bandpass', 1650, 0.9);
  const pan = v.pan(-0.08);
  n.connect(bp);
  bp.connect(g);
  g.connect(pan);
  pan.connect(out);
  send(v, pan, k.wet, 0.35);
}

/** Glassy FM pluck (arp): bright attack mellowing quickly, into the echo and a little reverb. */
export function pluck(k: MusicKit, t: number, midi: number, vel: number, out: AudioNode, echo: number, pan = 0): void {
  const v = k.pool.acquire(t, 0);
  if (!v) return;
  const f = midiToHz(midi);
  const g = v.gain(0);
  const end = percEnv(g.gain, t, vel, 0.003, 0.4);
  const car = v.osc('sine', f, t, end);
  const mod = v.osc('sine', f * 2, t, end);
  const idx = v.gain(0);
  // The decaying FM index is the brightness envelope (no per-note filter needed).
  idx.gain.setValueAtTime(f * 1.3, t);
  idx.gain.setTargetAtTime(f * 0.04, t, 0.06);
  mod.connect(idx);
  idx.connect(car.frequency);
  const pn = v.pan(pan);
  car.connect(g);
  g.connect(pn);
  pn.connect(out);
  send(v, pn, k.delay, echo);
  send(v, pn, k.wet, 0.2);
}

/** Soft FM bell (title motif / complete arps): harmonic ratio, long decay, generous reverb. */
export function bell(k: MusicKit, t: number, midi: number, vel: number, decay: number, out: AudioNode, echo: number, pan = 0): void {
  const v = k.pool.acquire(t, 0);
  if (!v) return;
  const f = midiToHz(midi);
  const g = v.gain(0);
  const end = percEnv(g.gain, t, vel, 0.004, decay);
  const car = v.osc('sine', f, t, end);
  const mod = v.osc('sine', f * 3, t, end);
  const idx = v.gain(0);
  idx.gain.setValueAtTime(f * 1.1, t);
  idx.gain.setTargetAtTime(f * 0.04, t, decay * 0.12);
  mod.connect(idx);
  idx.connect(car.frequency);
  const pn = v.pan(pan);
  car.connect(g);
  g.connect(pn);
  pn.connect(out);
  send(v, pn, k.delay, echo);
  send(v, pn, k.wet, 0.45);
}

/** Soft cymbal swell used on the landing "downbeat". */
export function cymbal(k: MusicKit, t: number, vel: number, out: AudioNode): void {
  const v = k.pool.acquire(t, 1);
  if (!v) return;
  const g = v.gain(0);
  const end = percEnv(g.gain, t, vel, 0.004, 1.8);
  const n = v.buffer(k.noise.white, t, end, { offset: noiseOffset(k, k.noise.white) });
  const hp = v.filter('highpass', 4200, 0.7);
  const pk = v.filter('peaking', 8500, 0.8, 4);
  n.connect(hp);
  hp.connect(pk);
  pk.connect(g);
  g.connect(out);
  send(v, g, k.wet, 0.6);
}
