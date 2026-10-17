/**
 * Procedural score: a lookahead step sequencer (16th-note grid) driving the instruments.
 *
 * Arrangements
 *   title     96 BPM — airy pads, deep sub swells, a sparse FM-bell motif; a soft pulse joins on the
 *             second pass and a whisper of shaker on the third (slow build while the menu is open).
 *   game      100 BPM — pads always; pulse bass, kick, hats, clap and a glassy arp enter as `intensity`
 *             rises (speed, airborne, boost); a high string-like "lift" layer follows the airborne amount.
 *             In the air the harmony suspends (VI → V7sus4, held); on a clean landing the grid re-syncs so
 *             the downbeat — tonic chord, bass accent, soft cymbal — lands exactly on touchdown.
 *   complete  96 BPM — D major resolution: pads, sub and gentle bell arpeggios.
 *
 * Layer levels follow intensity smoothly (no on/off steps); notes for silent layers are not scheduled.
 */
import { clamp, smoothstep } from '../dsp/math';
import { glide, ParamDriver } from '../dsp/params';
import { harmonicWave, softSawWave } from '../dsp/buffers';
import { VoicePool } from '../dsp/voice';
import type { NoiseBank } from '../sfx/synth';
import { ARRANGEMENTS, CHORDS, FLIGHT_HOLD, FLIGHT_LIFT, chordNotesInRange, type Arrangement, type ArrangementId, type Chord } from './theory';
import { bass, bell, clap, cymbal, hat, kick, pad, pluck, sub, type MusicKit, type Sustain } from './instruments';

export interface MusicHost {
  ctx: BaseAudioContext;
  rng: () => number;
  noise: NoiseBank;
  /** Music dry bus. */
  dry: AudioNode;
  /** Music reverb send bus. */
  wet: AudioNode;
}

type LayerId = 'pad' | 'shimmer' | 'bass' | 'kick' | 'hat' | 'clap' | 'arp' | 'bell' | 'sub' | 'pulse' | 'fx';
const LAYER_IDS: readonly LayerId[] = ['pad', 'shimmer', 'bass', 'kick', 'hat', 'clap', 'arp', 'bell', 'sub', 'pulse', 'fx'];

/** Scheduling horizon (s). Generous enough to ride out main-thread hitches of ~200 ms. */
const LOOKAHEAD = 0.25;

// Instrument levels (pre music-volume). Calibrated with the offline self-test.
const PAD_LEVEL = 0.032;
const SHIMMER_LEVEL = 0.026;
const SUB_LEVEL = 0.035;
const BASS_LEVEL = 0.085;
const KICK_LEVEL = 0.2;
const CLAP_LEVEL = 0.065;
const HAT_LEVEL = 0.055;
const ARP_LEVEL = 0.042;
const BELL_LEVEL = 0.048;
const PULSE_LEVEL = 0.055;
const CYMBAL_LEVEL = 0.032;

/** Arp contour over the chord tones in G4–D6. */
const ARP_PATTERN = [0, 2, 4, 1, 3, 5, 2, 4, 6, 3, 5, 7, 4, 2, 3, 1] as const;
/** Pulse-bass eighth-note accents. */
const BASS_VEL = [1, 0.62, 0.8, 0.6, 0.9, 0.62, 0.8, 0.7] as const;
/** Title bell motif: chord-tone index per 16th (-1 = rest), alternating bars. */
const TITLE_MOTIF_A = [2, -1, -1, -1, -1, -1, 4, -1, -1, -1, 3, -1, -1, -1, -1, -1] as const;
const TITLE_MOTIF_B = [-1, -1, 5, -1, -1, -1, -1, -1, 3, -1, -1, -1, 1, -1, 2, -1] as const;
/** Complete arpeggio (eighths). */
const COMPLETE_ARP = [0, 2, 4, 3, 5, 4, 2, 1] as const;

export interface MusicDebug {
  arrangement: ArrangementId;
  running: boolean;
  bar: number;
  step: number;
  chord: string;
  intensity: number;
  air: number;
  flight: boolean;
  voices: number;
}

export class MusicDirector {
  private readonly ctx: BaseAudioContext;
  private readonly pool: VoicePool;
  private readonly kit: MusicKit;
  private readonly nodes: AudioNode[] = [];
  private readonly lfos: OscillatorNode[] = [];
  private readonly layer = {} as Record<LayerId, GainNode>;
  private readonly level = {} as Record<LayerId, ParamDriver>;
  private readonly delayL: DelayNode;
  private readonly delayR: DelayNode;
  private readonly vibrato: GainNode;

  private arr: Arrangement = ARRANGEMENTS.title;
  private running = false;
  private bar = 0;
  private step = 0;
  private nextTime = 0;
  private holdUntil = 0;
  private chord: Chord = CHORDS.Dm9;
  private padChord: Chord | null = null;
  private padV: Sustain | null = null;
  private shimmerV: Sustain | null = null;
  private subV: Sustain | null = null;
  private padCut = 1000;
  private intensity = 0.3;
  private air = 0;
  private flight = false;
  private flightBars = 0;
  private accent = false;

  constructor(host: MusicHost) {
    const ctx = (this.ctx = host.ctx);
    this.pool = new VoicePool(ctx, 56);

    for (const id of LAYER_IDS) {
      const g = this.node(ctx.createGain());
      g.gain.value = 0;
      g.connect(host.dry);
      this.layer[id] = g;
      this.level[id] = new ParamDriver(g.gain, 0, 0.5, 0.004);
    }

    // Dotted-eighth ping-pong echo for plucks/bells: in → L → (lowpass) → R → feedback → L.
    const delayIn = this.node(ctx.createGain());
    this.delayL = this.node(ctx.createDelay(1.5));
    this.delayR = this.node(ctx.createDelay(1.5));
    const dlp = this.node(ctx.createBiquadFilter());
    dlp.type = 'lowpass';
    dlp.frequency.value = 3200;
    const dhp = this.node(ctx.createBiquadFilter());
    dhp.type = 'highpass';
    dhp.frequency.value = 260;
    const fb = this.node(ctx.createGain());
    fb.gain.value = 0.36;
    const panL = this.node(ctx.createStereoPanner());
    panL.pan.value = -0.7;
    const panR = this.node(ctx.createStereoPanner());
    panR.pan.value = 0.7;
    const delayOut = this.node(ctx.createGain());
    delayOut.gain.value = 0.55;
    const delayWet = this.node(ctx.createGain());
    delayWet.gain.value = 0.35;
    delayIn.connect(this.delayL);
    this.delayL.connect(dlp).connect(dhp);
    dhp.connect(panL).connect(delayOut);
    dhp.connect(this.delayR);
    this.delayR.connect(panR).connect(delayOut);
    this.delayR.connect(fb).connect(this.delayL);
    delayOut.connect(host.dry);
    delayOut.connect(delayWet).connect(host.wet);

    // Slow pad filter drift (±220 cents over ~14 s) and a gentle vibrato for the lift layer.
    const padLfo = this.lfo(0.07);
    const padDepth = this.node(ctx.createGain());
    padDepth.gain.value = 220;
    padLfo.connect(padDepth);
    const vib = this.lfo(4.8);
    this.vibrato = this.node(ctx.createGain());
    this.vibrato.gain.value = 7;
    vib.connect(this.vibrato);

    this.kit = {
      ctx,
      pool: this.pool,
      rng: host.rng,
      noise: host.noise,
      softSaw: softSawWave(ctx),
      kickWave: harmonicWave(ctx, [1, 0, 0.16, 0, 0.05]),
      padLfo: padDepth,
      delay: delayIn,
      wet: host.wet,
    };
    this.setDelayTime(0);
  }

  get arrangement(): ArrangementId {
    return this.arr.id;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Start or switch arrangement. Sustained voices crossfade out; the new one starts on a downbeat. */
  play(id: ArrangementId, t: number): void {
    if (this.running && this.arr.id === id) return;
    const first = !this.running;
    this.running = true;
    this.pool.cancelAfter(t + 0.02);
    this.releaseSustains(t + 0.02, first ? 0.3 : 1.4);
    this.arr = ARRANGEMENTS[id];
    this.bar = 0;
    this.step = 0;
    this.flight = false;
    this.flightBars = 0;
    this.accent = false;
    this.nextTime = Math.max(t + (first ? 0.05 : 0.35), this.holdUntil);
    this.applyLevels(t);
    this.setDelayTime(t);
  }

  /** Stop scheduling and release everything. */
  stop(t: number, release = 1.2): void {
    this.running = false;
    this.pool.cancelAfter(t);
    this.releaseSustains(t, release);
  }

  /** Gameplay drive (0..1 each), called every frame by the core. */
  setDrive(intensity: number, air: number, t: number): void {
    this.intensity = clamp(intensity, 0, 1);
    this.air = clamp(air, 0, 1);
    if (this.running) this.applyLevels(t);
  }

  /** Airborne long enough → suspend the harmony from the next bar. */
  enterFlight(): void {
    if (this.arr.id !== 'game' || this.flight) return;
    this.flight = true;
    this.flightBars = 0;
  }

  exitFlight(): void {
    this.flight = false;
    this.flightBars = 0;
  }

  /** Clean landing: re-sync the grid so the tonic downbeat lands on touchdown. */
  resolve(t: number): void {
    const wasFlying = this.flight;
    this.exitFlight();
    if (!wasFlying || !this.running || this.arr.id !== 'game' || t < this.holdUntil) return;
    this.pool.cancelAfter(t);
    this.bar = 0;
    this.step = 0;
    this.nextTime = t;
    this.accent = true;
    this.schedule(t);
  }

  /** Silence the score for `seconds` (level-complete fanfare), then restart on a downbeat. */
  holdFor(t: number, seconds: number): void {
    this.pool.cancelAfter(t);
    this.releaseSustains(t, 0.8);
    this.holdUntil = t + seconds;
    this.bar = 0;
    this.step = 0;
    this.exitFlight();
    this.accent = false;
    this.nextTime = this.holdUntil;
  }

  /**
   * End a pending hold early (restart or quit during the level-complete fanfare): the current
   * arrangement comes back on a fresh downbeat shortly after `t` instead of waiting out the hold.
   */
  cancelHold(t: number): void {
    if (this.holdUntil <= t) return;
    this.holdUntil = t;
    if (this.running && this.nextTime > t + 0.35) {
      this.bar = 0;
      this.step = 0;
      this.nextTime = t + 0.35;
    }
  }

  /** Schedule all steps up to now + LOOKAHEAD. Idempotent; call from a timer and/or every frame. */
  schedule(now: number): void {
    if (!this.running) return;
    if (this.nextTime < now - 0.12) this.nextTime = now + 0.03; // fell behind (hitch / resumed context)
    const horizon = now + LOOKAHEAD;
    let guard = 0;
    while (this.nextTime < horizon && guard++ < 64) this.playStep();
  }

  get debug(): MusicDebug {
    return {
      arrangement: this.arr.id,
      running: this.running,
      bar: this.bar,
      step: this.step,
      chord: this.chord.name,
      intensity: this.intensity,
      air: this.air,
      flight: this.flight,
      voices: this.pool.size,
    };
  }

  dispose(): void {
    this.pool.cancelAll();
    for (const o of this.lfos) {
      try {
        o.stop();
      } catch {
        /* ignore */
      }
    }
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.nodes.length = 0;
    this.lfos.length = 0;
  }

  /* ---------------------------------------------------------------- */

  private playStep(): void {
    const t = this.nextTime;
    const sd = 15 / this.arr.bpm; // 16th note
    if (this.step === 0) this.onBar(t);
    switch (this.arr.id) {
      case 'game':
        this.stepGame(t, sd);
        break;
      case 'title':
        this.stepTitle(t, sd);
        break;
      case 'complete':
        this.stepComplete(t, sd);
        break;
    }
    this.nextTime = t + sd;
    this.step = (this.step + 1) & 15;
    if (this.step === 0) this.bar++;
  }

  private onBar(t: number): void {
    const bars = this.arr.bars;
    let c = bars[this.bar % bars.length];
    if (this.arr.id === 'game' && this.flight) {
      c = this.flightBars === 0 && this.padChord !== FLIGHT_HOLD ? FLIGHT_LIFT : FLIGHT_HOLD;
      this.flightBars++;
    }
    this.chord = c;
    if (c !== this.padChord) this.changeChord(c, t);
    if (this.arr.id === 'title') this.applyLevels(t);
  }

  private changeChord(c: Chord, t: number): void {
    const id = this.arr.id;
    const rel = id === 'game' ? 1.1 : 1.8;
    this.padV?.release(t, rel);
    this.shimmerV?.release(t, rel);
    this.subV?.release(t, rel);
    this.padV = this.shimmerV = this.subV = null;
    const cutoff = id === 'game' ? this.gamePadCutoff() : id === 'title' ? 2000 : 2200;
    this.padCut = cutoff;
    this.padV = pad(this.kit, t, c.pad, {
      out: this.layer.pad,
      level: PAD_LEVEL,
      cutoff,
      attack: id === 'game' ? 0.9 : 1.8,
      release: rel,
      send: id === 'game' ? 0.45 : 0.6,
      wave: this.kit.softSaw,
      detune: 7,
      spread: 0.55,
      lfo: true,
    });
    // In game the lift layer only exists while airborne (created lazily in applyLevels) — no silent voices.
    if (id !== 'game' || this.air > 0.02) this.startLift(c, t);
    if (id !== 'game') this.subV = sub(this.kit, t, c.root, SUB_LEVEL, 1.5, rel, this.layer.sub);
    this.padChord = c;
  }

  /**
   * High "lift" voicing: the top three pad notes an octave up, string-like with vibrato. Follows the
   * airborne amount in game; a quiet halo on the title / complete screens.
   */
  private startLift(c: Chord, t: number): void {
    const game = this.arr.id === 'game';
    this.shimmerV = pad(this.kit, t, [c.pad[1] + 12, c.pad[2] + 12, c.pad[3] + 12], {
      out: this.layer.shimmer,
      level: SHIMMER_LEVEL,
      cutoff: 3200,
      attack: game ? 0.7 : 2.2,
      release: game ? 1.1 : 1.8,
      send: 0.6,
      wave: this.kit.softSaw,
      detune: 9,
      spread: 0.8,
      lfo: false,
      vibrato: this.vibrato,
    });
  }

  private gamePadCutoff(): number {
    return 1000 + 1600 * this.intensity + 900 * this.air;
  }

  private stepGame(t: number, sd: number): void {
    const s = this.step;
    const I = this.intensity;
    const c = this.chord;
    const accent = this.accent && s === 0;
    const k = this.kit;
    if (this.on('bass')) {
      if ((s & 1) === 0) {
        const up = s === 6 || s === 14 ? 12 : 0;
        const vel = BASS_VEL[s >> 1] * BASS_LEVEL * (accent ? 1.3 : 1) * this.humanize();
        bass(k, t, c.root + 12 + up, sd * 1.7, vel, 0.2 + 0.8 * I, this.layer.bass);
      } else if (I > 0.62 && (s === 3 || s === 11 || s === 15)) {
        bass(k, t, c.root + 12, sd * 0.8, 0.35 * BASS_LEVEL, 0.2 + 0.8 * I, this.layer.bass);
      }
    }
    if (this.on('kick') && !accent && (s === 0 || s === 8 || (I > 0.6 && (s === 4 || s === 12)))) {
      kick(k, t, KICK_LEVEL * (s === 0 ? 1 : 0.85), this.layer.kick);
    }
    if (this.on('clap') && (s === 4 || s === 12)) clap(k, t, CLAP_LEVEL, this.layer.clap);
    if (this.on('hat')) {
      if ((s & 3) === 2) hat(k, t, HAT_LEVEL * 0.8 * this.humanize(), false, this.layer.hat);
      else if (I > 0.66 && (s & 1) === 1) hat(k, t, HAT_LEVEL * 0.32 * this.humanize(), false, this.layer.hat);
      if (I > 0.82 && s === 14) hat(k, t, HAT_LEVEL * 0.5, true, this.layer.hat);
    }
    if (this.on('arp')) {
      const notes = chordNotesInRange(c, 67, 86);
      const n = notes[ARP_PATTERN[s] % notes.length];
      const vel = ((s & 3) === 0 ? 1 : 0.72) * ARP_LEVEL * this.humanize();
      pluck(k, t, n, vel, this.layer.arp, 0.35, ((s & 3) - 1.5) * 0.15);
    }
    if (accent) {
      cymbal(k, t, CYMBAL_LEVEL, this.layer.fx);
      this.accent = false;
    }
  }

  private stepTitle(t: number, sd: number): void {
    const s = this.step;
    const c = this.chord;
    const k = this.kit;
    const motif = (this.bar & 1) === 0 ? TITLE_MOTIF_A : TITLE_MOTIF_B;
    const idx = motif[s];
    if (idx >= 0) {
      const notes = chordNotesInRange(c, 72, 91);
      bell(k, t, notes[idx % notes.length], BELL_LEVEL * (0.75 + 0.25 * k.rng()), 2.4, this.layer.bell, 0.3, (idx - 2.5) * 0.15);
    }
    if (this.on('pulse') && (s & 1) === 0) {
      bass(k, t, c.root + 12, sd * 1.6, PULSE_LEVEL * ((s & 3) === 0 ? 1 : 0.7), 0.12, this.layer.pulse);
    }
    if (this.on('hat') && (s & 1) === 1) {
      hat(k, t, HAT_LEVEL * ((s & 3) === 3 ? 0.35 : 0.22), false, this.layer.hat);
    }
  }

  private stepComplete(t: number, _sd: number): void {
    const s = this.step;
    if ((s & 1) !== 0) return;
    const notes = chordNotesInRange(this.chord, 69, 88);
    const idx = COMPLETE_ARP[(s >> 1) & 7];
    const vel = BELL_LEVEL * 0.8 * ((s & 7) === 0 ? 1 : 0.75);
    bell(this.kit, t, notes[idx % notes.length], vel, 1.8, this.layer.bell, 0.25, (((s >> 1) % 3) - 1) * 0.3);
  }

  private applyLevels(t: number): void {
    const I = this.intensity;
    const A = this.air;
    switch (this.arr.id) {
      case 'game':
        this.setLevel('pad', 1, t);
        this.setLevel('shimmer', A, t);
        this.setLevel('bass', smoothstep(0.1, 0.3, I), t);
        this.setLevel('kick', smoothstep(0.15, 0.3, I), t);
        this.setLevel('hat', smoothstep(0.25, 0.4, I) * (0.6 + 0.4 * I), t);
        this.setLevel('clap', smoothstep(0.42, 0.55, I), t);
        this.setLevel('arp', smoothstep(0.42, 0.65, Math.max(I, A * 0.9)), t);
        this.setLevel('bell', 0, t);
        this.setLevel('sub', 0, t);
        this.setLevel('pulse', 0, t);
        this.setLevel('fx', 1, t);
        if (A > 0.05 && !this.shimmerV && this.padChord) this.startLift(this.padChord, t);
        if (this.padV?.filter) {
          const cut = this.gamePadCutoff();
          if (Math.abs(cut - this.padCut) > this.padCut * 0.03) {
            this.padCut = cut;
            glide(this.padV.filter.frequency, cut, t, 0.4);
          }
        }
        break;
      case 'title':
        this.setLevel('pad', 1, t);
        this.setLevel('bell', 1, t);
        this.setLevel('sub', 1, t);
        this.setLevel('pulse', this.bar >= 8 ? 1 : 0, t, 3);
        this.setLevel('hat', this.bar >= 16 ? 0.5 : 0, t, 3);
        this.setLevel('shimmer', 0.55, t, 2);
        this.setLevel('bass', 0, t);
        this.setLevel('kick', 0, t);
        this.setLevel('clap', 0, t);
        this.setLevel('arp', 0, t);
        this.setLevel('fx', 1, t);
        break;
      case 'complete':
        this.setLevel('pad', 1, t);
        this.setLevel('bell', 1, t);
        this.setLevel('sub', 1, t);
        this.setLevel('pulse', 0, t);
        this.setLevel('hat', 0, t);
        this.setLevel('shimmer', 0.45, t, 2);
        this.setLevel('bass', 0, t);
        this.setLevel('kick', 0, t);
        this.setLevel('clap', 0, t);
        this.setLevel('arp', 0, t);
        this.setLevel('fx', 1, t);
        break;
    }
  }

  /** Rise fast-ish, fall slowly (layers bloom in the air and settle after landing). */
  private setLevel(id: LayerId, v: number, t: number, tc?: number): void {
    const d = this.level[id];
    d.set(v, t, tc ?? (v > d.target ? 0.35 : 1.2));
  }

  private on(id: LayerId): boolean {
    return this.level[id].target > 0.02;
  }

  private humanize(): number {
    return 0.92 + 0.16 * this.kit.rng();
  }

  private releaseSustains(t: number, release: number): void {
    this.padV?.release(t, release);
    this.shimmerV?.release(t, release);
    this.subV?.release(t, release);
    this.padV = this.shimmerV = this.subV = null;
    this.padChord = null;
  }

  private setDelayTime(t: number): void {
    const dotted8th = (0.75 * 60) / this.arr.bpm;
    if (t <= 0) {
      this.delayL.delayTime.value = dotted8th;
      this.delayR.delayTime.value = dotted8th;
    } else {
      glide(this.delayL.delayTime, dotted8th, t, 0.3);
      glide(this.delayR.delayTime, dotted8th, t, 0.3);
    }
  }

  private node<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  private lfo(freq: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.frequency.value = freq;
    o.start();
    this.lfos.push(o);
    this.nodes.push(o);
    return o;
  }
}
