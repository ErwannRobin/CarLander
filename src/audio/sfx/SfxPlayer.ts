/**
 * Event one-shots and UI sounds. Everything is synthesised on demand into self-cleaning voices.
 *
 * Tonal material is drawn from the score's key (D minor / D Dorian; the level-complete fanfare turns to
 * D major) so chimes, dings and UI ticks always sit consonantly over the music.
 */
import { clamp, midiToHz } from '../dsp/math';
import type { Voice, VoicePool } from '../dsp/voice';
import type { UiSound } from '../types';
import { fmBell, noiseHit, partials, route, swellTone, thump as thumpRaw, tone, type Dest, type SynthKit, type ThumpOpts } from './synth';
import { harmonicWave } from '../dsp/buffers';
import { swellEnv } from '../dsp/params';
import type { LandingQuality } from '@/game/types';

export interface SfxHost {
  ctx: BaseAudioContext;
  kit: SynthKit;
  /** Gameplay one-shots. */
  pool: VoicePool;
  /** Interface sounds (separate budget so UI never starves gameplay). */
  uiPool: VoicePool;
  dry: AudioNode;
  wet: AudioNode;
}

/** D minor pentatonic ladder from A5 — trick dings climb it. */
const DING_LADDER = [81, 84, 86, 89, 91, 93, 96, 98] as const;
const hz = midiToHz;

/** A one-shot that can be faded out early (the level-complete fanfare when the player restarts). */
export interface FadeHandle {
  readonly voice: Voice;
  /** Fade to silence from `t` with time constant `tc` (click-free); the voice then ends on its own. */
  fade(t: number, tc: number): void;
}

export class SfxPlayer {
  /**
   * Thump waveform: sine + soft odd harmonics (3rd, 5th, 7th). Low hits (40–110 Hz) are inaudible on
   * laptop/phone speakers; their 3rd/5th harmonics (150–550 Hz) carry the punch there.
   */
  private readonly warm: PeriodicWave;

  constructor(private readonly h: SfxHost) {
    this.warm = harmonicWave(h.ctx, [1, 0, 0.24, 0, 0.09, 0, 0.035]);
  }

  /** Thump with the warm waveform unless another is requested. */
  private thump(v: Voice, d: Dest, t: number, o: ThumpOpts): number {
    return thumpRaw(v, d, t, o.type ? o : { ...o, type: this.warm });
  }

  /**
   * Impact "body": band-passed pink noise in the 200–600 Hz region — the part of a hit that small
   * speakers can reproduce (the thump below it is felt on headphones / subwoofers).
   */
  private body(v: Voice, d: Dest, t: number, freq: number, gain: number, decay: number, q = 0.9): void {
    noiseHit(v, this.h.kit, d, t, { buffer: this.n.pink, type: 'bandpass', freq, q, attack: 0.002, decay, gain });
  }

  private dest(send = 0, pan = 0): Dest {
    return { dry: this.h.dry, wet: this.h.wet, send, pan };
  }

  private voice(t: number, priority: 0 | 1 | 2 = 1): Voice | null {
    return this.h.pool.acquire(t, priority);
  }

  private get n() {
    return this.h.kit.noise;
  }

  private rnd(): number {
    return this.h.kit.rng();
  }

  /* ---------------------------------------------------------------- */
  /* Rocket                                                            */
  /* ---------------------------------------------------------------- */

  /** Ignition: igniter tick + low "whump" + a flame burst that hands over to the continuous roar. */
  boostIgnition(t: number, p: number): void {
    const v = this.voice(t, 1);
    if (!v) return;
    const k = this.h.kit;
    noiseHit(v, k, this.dest(), t, { buffer: this.n.white, type: 'highpass', freq: 3200, attack: 0.0008, decay: 0.014, gain: 0.07 });
    this.thump(v, this.dest(0.08), t, { f0: 96 * p, f1: 40 * p, sweepTime: 0.2, decay: 0.42, gain: 0.2 });
    noiseHit(v, k, this.dest(0.1), t + 0.004, {
      buffer: this.n.pink,
      type: 'lowpass',
      freq: 320 * p,
      freqTo: 3600 * p,
      sweepTime: 0.09,
      q: 0.9,
      drive: k.curves.grit,
      driveGain: 1.6,
      attack: 0.02,
      decay: 0.55,
      gain: 0.26,
    });
  }

  /** Cut-off: the flame chokes — falling lowpass "pff" plus a soft pop. */
  boostCutoff(t: number, p: number): void {
    const v = this.voice(t, 1);
    if (!v) return;
    noiseHit(v, this.h.kit, this.dest(0.08), t, {
      buffer: this.n.pink,
      type: 'lowpass',
      freq: 2400 * p,
      freqTo: 260 * p,
      sweepTime: 0.32,
      q: 0.8,
      attack: 0.004,
      decay: 0.38,
      gain: 0.13,
    });
    this.thump(v, this.dest(), t, { f0: 125 * p, f1: 55 * p, sweepTime: 0.06, decay: 0.1, gain: 0.08 });
  }

  /** Out of fuel: irregular coughs, then a quiet descending two-note warning (E5 → A4). */
  fuelSputter(t: number): void {
    const v = this.voice(t, 1);
    if (!v) return;
    const k = this.h.kit;
    const times = [0, 0.1, 0.17, 0.31, 0.5, 0.63];
    const levels = [1, 0.65, 0.85, 0.5, 0.38, 0.22];
    for (let i = 0; i < times.length; i++) {
      const tt = t + times[i];
      const g = levels[i];
      noiseHit(v, k, this.dest(0.05, (this.rnd() - 0.5) * 0.3), tt, {
        buffer: this.n.pink,
        type: 'bandpass',
        freq: 520 + this.rnd() * 380,
        q: 1.3,
        drive: k.curves.grit,
        driveGain: 2,
        attack: 0.003,
        decay: 0.06 + this.rnd() * 0.04,
        gain: 0.2 * g,
      });
      this.thump(v, this.dest(), tt, { f0: 72, f1: 45, sweepTime: 0.04, decay: 0.07, gain: 0.12 * g });
    }
    tone(v, this.dest(0.2), t + 0.78, { type: 'sine', freq: hz(76), attack: 0.004, decay: 0.12, gain: 0.032 });
    tone(v, this.dest(0.2), t + 0.9, { type: 'sine', freq: hz(69), attack: 0.004, decay: 0.2, gain: 0.03 });
  }

  /** Short cold-gas puff when an RCS axis fires. */
  rcsPuff(t: number, pan: number, strength: number): void {
    const v = this.h.pool.acquire(t, 0);
    if (!v) return;
    noiseHit(v, this.h.kit, this.dest(0, pan), t, {
      buffer: this.n.pink,
      pre: { type: 'highpass', freq: 1200 },
      type: 'bandpass',
      freq: 3000,
      q: 0.8,
      attack: 0.002,
      decay: 0.06,
      gain: 0.16 * clamp(strength, 0.3, 1),
    });
  }

  /* ---------------------------------------------------------------- */
  /* Vacuum adhesion                                                   */
  /* ---------------------------------------------------------------- */

  /** Vacuum on: a solid thunk and a rising whoosh as the turbine spools. */
  vacuumOn(t: number): void {
    const v = this.voice(t, 1);
    if (!v) return;
    const k = this.h.kit;
    this.thump(v, this.dest(0.05), t, { f0: 84, f1: 46, sweepTime: 0.1, decay: 0.2, gain: 0.18 });
    this.body(v, this.dest(0.05), t, 300, 0.5, 0.1, 0.8);
    noiseHit(v, k, this.dest(), t, { buffer: this.n.white, type: 'lowpass', freq: 2600, attack: 0.001, decay: 0.02, gain: 0.07 });
    noiseHit(v, k, this.dest(0.12), t + 0.02, {
      buffer: this.n.pink,
      type: 'bandpass',
      freq: 260,
      freqTo: 2600,
      sweepTime: 0.75,
      q: 1.6,
      swell: true,
      attack: 0.45,
      decay: 0.35,
      gain: 0.3,
    });
    tone(v, this.dest(0.1), t + 0.03, { type: 'sine', freq: 320, freqTo: 980, glide: 0.8, attack: 0.25, decay: 0.6, gain: 0.014 });
  }

  /** Vacuum engaged: a mechanical double-latch "ka-chunk" with a pressure thump. */
  vacuumEngaged(t: number): void {
    const v = this.voice(t, 1);
    if (!v) return;
    const k = this.h.kit;
    this.thump(v, this.dest(0.05), t, { f0: 70, f1: 44, sweepTime: 0.06, decay: 0.15, gain: 0.16 });
    this.body(v, this.dest(0.05), t, 360, 0.55, 0.09, 0.8);
    partials(v, k, this.dest(0.15), t, {
      freqs: [182, 414, 961, 1733, 2620],
      decays: [0.22, 0.15, 0.1, 0.07, 0.05],
      gains: [0.1, 0.06, 0.04, 0.022, 0.011],
      spread: 0.02,
    });
    noiseHit(v, k, this.dest(), t, { buffer: this.n.white, type: 'highpass', freq: 2400, attack: 0.0008, decay: 0.008, gain: 0.08 });
    noiseHit(v, k, this.dest(), t + 0.034, { buffer: this.n.white, type: 'highpass', freq: 2600, attack: 0.0008, decay: 0.007, gain: 0.05 });
    partials(v, k, this.dest(0.1), t + 0.034, { freqs: [1210, 2930], decays: [0.04, 0.03], gains: [0.03, 0.014] });
    noiseHit(v, k, this.dest(), t + 0.01, { buffer: this.n.brown, type: 'lowpass', freq: 300, attack: 0.004, decay: 0.15, gain: 0.12 });
  }

  /** Vacuum released: seal breaks with a falling hiss. */
  vacuumReleased(t: number): void {
    const v = this.voice(t, 1);
    if (!v) return;
    noiseHit(v, this.h.kit, this.dest(0.1), t, {
      buffer: this.n.white,
      pre: { type: 'highpass', freq: 1100 },
      type: 'bandpass',
      freq: 4200,
      freqTo: 1600,
      sweepTime: 0.55,
      q: 0.9,
      attack: 0.008,
      decay: 0.6,
      gain: 0.21,
    });
    this.thump(v, this.dest(), t, { f0: 110, f1: 70, sweepTime: 0.05, decay: 0.08, gain: 0.07 });
  }

  /** Vacuum switched off: quiet power-down blip (the turbine layer spins down by itself). */
  vacuumOff(t: number): void {
    const v = this.voice(t, 0);
    if (!v) return;
    tone(v, this.dest(0.1), t, { type: 'sine', freq: 540, freqTo: 170, glide: 0.28, attack: 0.004, decay: 0.3, gain: 0.03 });
  }

  /* ---------------------------------------------------------------- */
  /* Air, tricks, landing                                              */
  /* ---------------------------------------------------------------- */

  /** Takeoff: stereo upward whoosh scaled by speed (the road layer dropping out does the rest). */
  takeoff(t: number, speed: number): void {
    const v = this.voice(t, 1);
    if (!v) return;
    const k = clamp(speed / 50, 0.35, 1.2);
    for (const side of [-1, 1]) {
      noiseHit(v, this.h.kit, this.dest(0.05, side * 0.3), t, {
        buffer: this.n.pink,
        type: 'bandpass',
        freq: side < 0 ? 380 : 430,
        freqTo: side < 0 ? 1900 : 2150,
        sweepTime: 0.5,
        q: 1.1,
        swell: true,
        attack: 0.09,
        decay: 0.45,
        gain: 0.42 * k,
      });
    }
  }

  /** Trick completed: a glassy ding that climbs the pentatonic ladder with every trick in the jump. */
  trickDing(t: number, index: number): void {
    const v = this.voice(t, 1);
    if (!v) return;
    const m = DING_LADDER[clamp(Math.round(index) - 1, 0, DING_LADDER.length - 1)];
    fmBell(v, this.dest(0.32), t, { freq: hz(m), ratio: 3.5, index: 0.75, decay: 0.95, gain: 0.12, brightness: 0.12 });
    fmBell(v, this.dest(0.32), t, { freq: hz(m + 12), ratio: 2, index: 0.3, decay: 0.3, gain: 0.022 });
  }

  /**
   * Landing by quality. `body` (0..1) scales only the low impact layers (thump / body noise): the sim
   * reports a landing ~0.15 s after the touchdown whose wheel slams already sounded, so the host passes
   * < 1 there to avoid a second thud. Chime / knock / crunch / rattle — the verdict — always play fully.
   */
  landing(t: number, quality: LandingQuality, impactSpeed: number, p: number, body = 1): void {
    const b = clamp(body, 0, 1);
    switch (quality) {
      case 'perfect':
        this.landPerfect(t, p, b);
        break;
      case 'clean':
        this.landClean(t, impactSpeed, p, b);
        break;
      case 'hard':
        this.landHard(t, p, 1, b);
        break;
      case 'crash':
        // The crash event carries the big sound; this is just the body hitting the deck.
        this.landHard(t, p, 0.6, b);
        break;
    }
  }

  /** PERFECT: soft touchdown, bright D-sus chime arpeggio (A5 D6 E6 A6) and a warm bass swell on D. */
  private landPerfect(t: number, p: number, b: number): void {
    const v = this.voice(t, 2);
    if (!v) return;
    this.thump(v, this.dest(), t, { f0: 92 * p, f1: 46 * p, sweepTime: 0.08, decay: 0.22, gain: 0.16 * b });
    this.body(v, this.dest(), t, 380 * p, 0.3 * b, 0.1);
    const notes = [81, 86, 88, 93];
    for (let i = 0; i < notes.length; i++) {
      fmBell(v, this.dest(0.45, (i - 1.5) * 0.28), t + 0.03 + i * 0.055, {
        freq: hz(notes[i]),
        ratio: 3.5,
        index: 0.7,
        decay: 1.7 - i * 0.15,
        gain: 0.075,
        brightness: 0.1,
      });
    }
    swellTone(v, this.dest(0.15), t + 0.02, { freq: hz(38), attack: 0.12, hold: 0.1, release: 1.4, gain: 0.1 });
    swellTone(v, this.dest(0.2), t + 0.02, { type: 'triangle', freq: hz(50), attack: 0.15, hold: 0.1, release: 1.2, gain: 0.055, lowpass: 600 });
  }

  /** CLEAN: a satisfying, round thump with a short tire chirp and a soft wooden "tock". */
  private landClean(t: number, impact: number, p: number, b: number): void {
    const v = this.voice(t, 2);
    if (!v) return;
    const k = this.h.kit;
    const s = clamp(0.75 + impact / 24, 0.75, 1.15);
    this.thump(v, this.dest(0.04), t, { f0: 112 * p, f1: 55 * p, sweepTime: 0.08, decay: 0.2, gain: 0.22 * s * b });
    this.body(v, this.dest(0.04), t, 300 * p, 1.15 * s * b, 0.17, 0.8);
    noiseHit(v, k, this.dest(), t + 0.004, { buffer: this.n.white, type: 'bandpass', freq: 1150 * p, q: 7, attack: 0.003, decay: 0.07, gain: 0.05 });
    // Suspension "knock" on D4 — tonal, consonant with the score, audible on any speaker.
    tone(v, this.dest(0.12), t + 0.004, { type: 'triangle', freq: hz(62) * p, freqTo: hz(60) * p, glide: 0.06, attack: 0.002, decay: 0.12, gain: 0.13 });
  }

  /** HARD: deep thud, crunchy distorted body noise, metallic rattle and suspension bottom-out. */
  private landHard(t: number, p: number, level: number, b: number): void {
    const v = this.voice(t, 2);
    if (!v) return;
    const k = this.h.kit;
    this.thump(v, this.dest(0.06), t, { f0: 92 * p, f1: 36 * p, sweepTime: 0.15, decay: 0.45, gain: 0.4 * level * b });
    this.body(v, this.dest(0.05), t, 320 * p, 0.6 * level * b, 0.18);
    noiseHit(v, k, this.dest(0.05), t, {
      buffer: this.n.white,
      type: 'bandpass',
      freq: 1500 * p,
      q: 0.9,
      drive: k.curves.crunch,
      driveGain: 3,
      attack: 0.002,
      decay: 0.22,
      gain: 0.26 * level,
    });
    const rattle = { freqs: [310, 777, 1630, 2890], decays: [0.22, 0.16, 0.1, 0.06], spread: 0.04, pitch: p };
    partials(v, k, this.dest(0.1), t, { ...rattle, gains: [0.07, 0.05, 0.03, 0.015], gain: level });
    partials(v, k, this.dest(0.1), t + 0.075, { ...rattle, gains: [0.04, 0.028, 0.016, 0.008], gain: level });
    this.thump(v, this.dest(), t + 0.01, { f0: 150 * p, f1: 90 * p, sweepTime: 0.03, decay: 0.07, gain: 0.16 * level });
    noiseHit(v, k, this.dest(), t, { buffer: this.n.pink, type: 'lowpass', freq: 500 * p, attack: 0.003, decay: 0.25, gain: 0.18 * level * b });
  }

  /** Suspension slam: short low thud + click, scaled by strength. */
  wheelSlam(t: number, strength: number, p: number): void {
    const s = clamp(strength, 0, 1);
    if (s < 0.05) return;
    const v = this.voice(t, 0);
    if (!v) return;
    const k = this.h.kit;
    this.thump(v, this.dest(), t, { f0: 86 * p, f1: 50 * p, sweepTime: 0.07, decay: 0.12 + 0.06 * s, gain: 0.15 * s });
    this.body(v, this.dest(), t, 280 * p, 0.95 * s, 0.11, 0.8);
    noiseHit(v, k, this.dest(), t, { buffer: this.n.pink, type: 'lowpass', freq: 1800 * p, attack: 0.001, decay: 0.03, gain: 0.08 * s });
    partials(v, k, this.dest(0.05), t, { freqs: [1870, 3120], decays: [0.03, 0.02], gains: [0.02 * s, 0.01 * s], pitch: p });
  }

  /** Chassis impact: metallic clank + gritty scrape transient (the sustained scrape is a layer). */
  impact(t: number, strength: number, p: number): void {
    const s = clamp(strength, 0, 1);
    const v = this.voice(t, s > 0.5 ? 1 : 0);
    if (!v) return;
    const k = this.h.kit;
    partials(v, k, this.dest(0.12, (this.rnd() - 0.5) * 0.4), t, {
      freqs: [217, 563, 1187, 2311, 3480],
      decays: [0.26, 0.19, 0.12, 0.08, 0.05],
      gains: [0.1, 0.07, 0.05, 0.03, 0.015],
      spread: 0.08,
      pitch: p,
      // Light grazes (the sim reports any contact from 1 m/s, strength ≈ 0.05) stay a soft tick.
      gain: 0.2 + 0.8 * s,
    });
    noiseHit(v, k, this.dest(0.05), t, {
      buffer: this.n.white,
      type: 'bandpass',
      freq: 2200 * p,
      q: 1.2,
      drive: k.curves.grit,
      driveGain: 2,
      attack: 0.002,
      decay: 0.06 + 0.1 * s,
      gain: 0.1 * s,
    });
    if (s > 0.55) {
      this.thump(v, this.dest(), t, { f0: 85 * p, f1: 45 * p, sweepTime: 0.07, decay: 0.2, gain: 0.17 * s });
      this.body(v, this.dest(), t, 340 * p, 0.4 * s, 0.09);
    }
  }

  /** Crash: crunch + crumpling metal + low boom, then scattered debris over ~1.5 s. */
  crash(t: number, impactSpeed: number, p: number): void {
    const v = this.voice(t, 2);
    if (!v) return;
    const k = this.h.kit;
    const s = clamp(impactSpeed / 22, 0.6, 1.15);
    this.thump(v, this.dest(0.35), t, { f0: 72 * p, f1: 31 * p, sweepTime: 0.55, decay: 1.35, gain: 0.4 * s });
    this.body(v, this.dest(0.2), t, 300 * p, 0.36 * s, 0.35);
    noiseHit(v, k, this.dest(0.25), t, { buffer: this.n.brown, type: 'lowpass', freq: 260 * p, attack: 0.004, decay: 1.1, gain: 0.32 * s });
    noiseHit(v, k, this.dest(0.1), t, {
      buffer: this.n.white,
      type: 'bandpass',
      freq: 1250 * p,
      q: 0.7,
      drive: k.curves.crunch,
      driveGain: 3.5,
      attack: 0.002,
      decay: 0.38,
      gain: 0.32 * s,
    });
    // Crumple: short random bandpassed grains.
    for (let i = 0; i < 6; i++) {
      const tt = t + 0.01 + Math.pow(this.rnd(), 1.3) * 0.32;
      noiseHit(v, k, this.dest(0.08, (this.rnd() * 2 - 1) * 0.5), tt, {
        buffer: this.n.white,
        type: 'bandpass',
        freq: (900 + this.rnd() * 2600) * p,
        q: 2 + this.rnd() * 3,
        drive: k.curves.grit,
        driveGain: 2.5,
        attack: 0.001,
        decay: 0.03 + this.rnd() * 0.05,
        gain: (0.08 + this.rnd() * 0.12) * s,
      });
    }
    partials(v, k, this.dest(0.2), t + 0.012, {
      freqs: [190, 470, 1020, 2210, 3390],
      decays: [0.55, 0.38, 0.24, 0.13, 0.07],
      gains: [0.1, 0.07, 0.05, 0.03, 0.015],
      spread: 0.07,
      pitch: p,
      gain: 1.4 * s,
    });
    // Debris: small pings and ticks, sparser and quieter over time.
    for (let i = 0; i < 10; i++) {
      const dt = 0.12 + Math.pow(this.rnd(), 1.6) * 1.35;
      const fade = clamp(1 - dt / 1.6, 0.15, 1);
      const pan = (this.rnd() * 2 - 1) * 0.7;
      if (this.rnd() < 0.6) {
        const f = (2000 + this.rnd() * 3500) * p;
        partials(v, k, this.dest(0.15, pan), t + dt, {
          freqs: [f, f * 1.47],
          decays: [0.04 + this.rnd() * 0.06, 0.03],
          gains: [0.05 * fade, 0.022 * fade],
        });
      } else {
        noiseHit(v, k, this.dest(0.1, pan), t + dt, { buffer: this.n.white, type: 'highpass', freq: 2500, attack: 0.001, decay: 0.012, gain: 0.075 * fade });
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Progress & flow                                                   */
  /* ---------------------------------------------------------------- */

  /** Objective complete: crisp two-note tick (D6 → A6). Returns the voice (the host may drop it unplayed). */
  objectiveTick(t: number): Voice | null {
    const v = this.voice(t, 1);
    if (!v) return null;
    fmBell(v, this.dest(0.25), t, { freq: hz(86), ratio: 3.5, index: 0.5, decay: 0.22, gain: 0.082 });
    fmBell(v, this.dest(0.25), t + 0.06, { freq: hz(93), ratio: 3.5, index: 0.5, decay: 0.34, gain: 0.073 });
    noiseHit(v, this.h.kit, this.dest(), t, { buffer: this.n.white, type: 'highpass', freq: 5000, attack: 0.0006, decay: 0.006, gain: 0.02 });
    return v;
  }

  /** Checkpoint: a single quieter D6 tick. */
  checkpoint(t: number): void {
    const v = this.voice(t, 0);
    if (!v) return;
    fmBell(v, this.dest(0.2), t, { freq: hz(86), ratio: 3.5, index: 0.45, decay: 0.3, gain: 0.055 });
  }

  /** Tutorial prompt: soft upward two-tone (A5 → D6). */
  notify(t: number): void {
    const v = this.voice(t, 0);
    if (!v) return;
    tone(v, this.dest(0.3), t, { type: 'sine', freq: hz(81), attack: 0.008, decay: 0.25, gain: 0.048 });
    tone(v, this.dest(0.3), t + 0.085, { type: 'sine', freq: hz(86), attack: 0.008, decay: 0.32, gain: 0.048 });
  }

  /** Restart: soft downward whoosh. */
  resetWhoosh(t: number): void {
    const v = this.voice(t, 1);
    if (!v) return;
    noiseHit(v, this.h.kit, this.dest(0.1), t, {
      buffer: this.n.pink,
      type: 'bandpass',
      freq: 2300,
      freqTo: 480,
      sweepTime: 0.45,
      q: 1.1,
      swell: true,
      attack: 0.14,
      decay: 0.32,
      gain: 0.2,
    });
  }

  /** Bullet time begins: sub drop + low swell. */
  slowmoIn(t: number): void {
    const v = this.voice(t, 1);
    if (!v) return;
    swellTone(v, this.dest(0.2), t, { type: this.warm, freq: 140, freqTo: 50, glide: 0.6, attack: 0.05, hold: 0.1, release: 0.6, gain: 0.11 });
    noiseHit(v, this.h.kit, this.dest(0.2), t, {
      buffer: this.n.pink,
      type: 'bandpass',
      freq: 1100,
      freqTo: 380,
      sweepTime: 0.6,
      q: 1,
      swell: true,
      attack: 0.2,
      decay: 0.4,
      gain: 0.12,
    });
  }

  /** Bullet time ends: quick upward whoosh. */
  slowmoOut(t: number): void {
    const v = this.voice(t, 0);
    if (!v) return;
    noiseHit(v, this.h.kit, this.dest(0.1), t, {
      buffer: this.n.pink,
      type: 'bandpass',
      freq: 420,
      freqTo: 1900,
      sweepTime: 0.3,
      q: 1.2,
      swell: true,
      attack: 0.08,
      decay: 0.25,
      gain: 0.25,
    });
  }

  /**
   * Level complete fanfare (~3.5 s): soft synth-brass bVI → bVII → I (Bb → C → D major, the Picardy
   * lift out of the minor-key score), timpani-like swells and a bell arpeggio on top. Everything runs
   * through one sub-bus so a restart can fade it out (the returned handle).
   */
  fanfare(t: number): FadeHandle | null {
    const v = this.voice(t, 2);
    if (!v) return null;
    const k = this.h.kit;
    const busDry = v.gain(1);
    const busWet = v.gain(1);
    busDry.connect(this.h.dry);
    busWet.connect(this.h.wet);
    const d = (send = 0, pan = 0): Dest => ({ dry: busDry, wet: busWet, send, pan });
    this.brassChord(v, d(0.4), t, [58, 62, 65, 72], 0.34, 0.042);
    this.brassChord(v, d(0.4), t + 0.3, [60, 64, 67, 74], 0.34, 0.044);
    this.brassChord(v, d(0.4), t + 0.6, [50, 62, 66, 69, 76], 2.0, 0.048);
    this.thump(v, d(0.35), t, { f0: 98, f1: 58, sweepTime: 0.12, decay: 0.55, gain: 0.2 });
    this.thump(v, d(0.4), t + 0.6, { f0: 112, f1: hz(38), sweepTime: 0.1, decay: 1.2, gain: 0.28 });
    const bells = [86, 90, 93, 98];
    for (let i = 0; i < bells.length; i++) {
      fmBell(v, d(0.5, (i - 1.5) * 0.3), t + 0.62 + i * 0.08, {
        freq: hz(bells[i]),
        ratio: 3.5,
        index: 0.6,
        decay: 1.8,
        gain: 0.042,
        brightness: 0.1,
      });
    }
    noiseHit(v, k, d(0.6), t + 0.58, {
      buffer: this.n.white,
      pre: { type: 'highpass', freq: 5000 },
      type: 'peaking',
      freq: 9000,
      q: 0.7,
      swell: true,
      attack: 0.06,
      decay: 1.6,
      gain: 0.025,
    });
    return {
      voice: v,
      fade(at: number, tc: number): void {
        if (v.isFinished) return;
        // setTargetAtTime only (no cancel): the bus gains carry no other automation.
        busDry.gain.setTargetAtTime(0, at, Math.max(0.005, tc));
        busWet.gain.setTargetAtTime(0, at, Math.max(0.005, tc));
      },
    };
  }

  /** Synth-brass chord: detuned saws through an enveloped lowpass (soft "blat" then mellow). */
  private brassChord(v: Voice, dest: Dest, t: number, notes: readonly number[], dur: number, level: number): void {
    const filt = v.filter('lowpass', 450, 1.1);
    filt.frequency.setValueAtTime(450, t);
    filt.frequency.setTargetAtTime(2600, t, 0.03);
    filt.frequency.setTargetAtTime(1500, t + 0.09, 0.15);
    const env = v.gain(0);
    const end = swellEnv(env.gain, t, level, 0.045, t + dur, 0.55);
    for (const m of notes) {
      const f = hz(m);
      const a = v.osc('sawtooth', f, t, end, -7);
      const b = v.osc('sawtooth', f, t, end, 7);
      a.connect(filt);
      b.connect(filt);
    }
    filt.connect(env);
    route(v, env, dest);
  }

  /* ---------------------------------------------------------------- */
  /* UI                                                                */
  /* ---------------------------------------------------------------- */

  ui(kind: UiSound, t: number): void {
    const v = this.h.uiPool.acquire(t, kind === 'hover' ? 0 : 1);
    if (!v) return;
    const k = this.h.kit;
    const d = (send = 0, pan = 0): Dest => ({ dry: this.h.dry, wet: this.h.wet, send, pan });
    switch (kind) {
      case 'hover':
        tone(v, d(0.05), t, { type: 'sine', freq: hz(93), attack: 0.0015, decay: 0.03, gain: 0.024 });
        noiseHit(v, k, d(), t, { buffer: this.n.white, type: 'highpass', freq: 6000, attack: 0.0005, decay: 0.004, gain: 0.007 });
        break;
      case 'click':
        tone(v, d(0.08), t, { type: 'triangle', freq: hz(86), freqTo: 900, glide: 0.03, attack: 0.001, decay: 0.06, gain: 0.085 });
        noiseHit(v, k, d(), t, { buffer: this.n.white, type: 'bandpass', freq: 3500, q: 1, attack: 0.0006, decay: 0.008, gain: 0.06 });
        break;
      case 'back':
        tone(v, d(0.1), t, { type: 'sine', freq: hz(81), attack: 0.002, decay: 0.07, gain: 0.064 });
        tone(v, d(0.1), t + 0.055, { type: 'sine', freq: hz(76), attack: 0.002, decay: 0.1, gain: 0.056 });
        break;
      case 'toggle':
        tone(v, d(0.08), t, { type: 'sine', freq: hz(86), freqTo: hz(93), glide: 0.04, attack: 0.002, decay: 0.07, gain: 0.064 });
        noiseHit(v, k, d(), t, { buffer: this.n.white, type: 'bandpass', freq: 3000, q: 1, attack: 0.0006, decay: 0.006, gain: 0.04 });
        break;
      case 'start': {
        noiseHit(v, k, d(0.15), t, {
          buffer: this.n.pink,
          type: 'bandpass',
          freq: 350,
          freqTo: 3200,
          sweepTime: 0.38,
          q: 1.1,
          swell: true,
          attack: 0.3,
          decay: 0.25,
          gain: 0.2,
        });
        const chord = [74, 81, 88];
        for (let i = 0; i < chord.length; i++) {
          fmBell(v, d(0.45, (i - 1) * 0.35), t + 0.3 + i * 0.012, { freq: hz(chord[i]), ratio: 2, index: 0.5, decay: 1.4, gain: 0.05 - i * 0.005 });
        }
        swellTone(v, d(0.1), t + 0.3, { freq: hz(38), attack: 0.05, hold: 0.05, release: 0.9, gain: 0.07 });
        break;
      }
      case 'unlock': {
        const arp = [81, 86, 88, 93];
        for (let i = 0; i < arp.length; i++) {
          fmBell(v, d(0.5, (i - 1.5) * 0.3), t + i * 0.07, { freq: hz(arp[i]), ratio: 3.5, index: 0.6, decay: 1.0, gain: 0.05, brightness: 0.1 });
        }
        break;
      }
    }
  }
}
