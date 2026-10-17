/**
 * SoundCore — the complete audio graph for one BaseAudioContext (live AudioContext or an
 * OfflineAudioContext in the self-test, so what is measured is exactly what plays).
 *
 *   music layers + sky ambience ─► musicDry ─► duck LP ─► duck·vol ──────────┐
 *            └────► musicWet ─► duck LP ─► duck·vol ─► reverbIn             │
 *   vehicle layers ─► slow-mo LP ─► gate ─┐                                 │
 *   one-shots / UI ───────────────────────┴► sfxDry ─► vol ────────────────┤
 *            └────► sfxWet ─► vol ─► reverbIn                               │
 *   reverbIn ─► HP 180 ─► convolver (generated IR) ─► return ──────────────┤
 *                                                                           ▼
 *   masterIn(trim) ─► HP 24 ─► glue comp ─► limiter ─► soft clip (≤ 0.955) ─► master·mute ─► out
 */
import type { GameEvent, RenderFrame } from '@/game/types';
import { clamp, createRng, fin, sliderToGain, smoothK, smoothstep } from '../dsp/math';
import { glide } from '../dsp/params';
import { crackleBuffer, driveCurve, impulseResponse, noiseBuffer, softClipCurve } from '../dsp/buffers';
import { VoicePool, type Voice } from '../dsp/voice';
import { VehicleLayers, type LayerName } from '../layers/VehicleLayers';
import { SfxPlayer, type FadeHandle } from '../sfx/SfxPlayer';
import type { NoiseBank, SynthKit } from '../sfx/synth';
import { MusicDirector, type MusicDebug } from '../music/MusicDirector';
import { SkyAmbience } from './SkyAmbience';
import { DEFAULT_MIX, type AudioMix, type AudioScene, type UiSound } from '../types';

/** Input span of the final soft clipper (it is fed through a 1/CLIP_RANGE gain). */
const CLIP_RANGE = 2;
/** Headroom trim into the master dynamics. */
const MASTER_TRIM = 0.7;
/** Reverb return level (the convolver normalises its IR). */
const REVERB_RETURN = 0.5;
/**
 * DynamicsCompressorNode starts heavily attenuated and ramps in its automatic makeup gain over
 * ~150–300 ms (measured: limiter -16 dB at 5 ms, -3 dB at 50 ms). One-shots requested right after the
 * context is created are deferred to this point so the very first click is not swallowed.
 */
const WARM_UP = 0.15;
/** Sky ambience bed level (linear, into the music bus) and its per-scene amount. */
const AMBIENCE_LEVEL = 0.12;
const AMBIENCE_BY_SCENE: Record<AudioScene, number> = { title: 1, game: 0.55, paused: 0.6, complete: 0.8 };
/**
 * The sim reports a landing at the end of its touchdown window (TUNING.landing.touchdownWindow, 0.15 s),
 * after the touchdown's `wheelSlam` events already sounded. A slam this recent is "the impact" and the
 * landing only adds its verdict over a light settle (see SfxPlayer.landing `body`).
 */
const SLAM_BEFORE_LANDING = 0.35;
/**
 * The sim reports a sustained chassis scrape as an `impact` every ~0.1 s of sim time. Reports closer
 * than this (sim seconds) belong to one continuous contact.
 */
const SCRAPE_CONTINUITY = 0.25;

export interface SoundCoreOptions {
  mix?: AudioMix;
  scene?: AudioScene;
  /** Build the score (offline SFX tests disable it). Default true. */
  music?: boolean;
  seed?: number;
}

export interface CoreDebug {
  scene: AudioScene;
  intensity: number;
  air: number;
  vehicleOpen: boolean;
  slowmo: boolean;
  crashed: boolean;
  sfxVoices: number;
  uiVoices: number;
  music: MusicDebug | null;
}

export class SoundCore {
  readonly ctx: BaseAudioContext;
  /** Final output (connect to ctx.destination). */
  readonly output: GainNode;
  readonly vehicle: VehicleLayers;
  readonly sfx: SfxPlayer;
  readonly music: MusicDirector | null;
  readonly ambience: SkyAmbience | null;
  readonly noise: NoiseBank;

  private readonly nodes: AudioNode[] = [];
  private readonly sfxPool: VoicePool;
  private readonly uiPool: VoicePool;
  private readonly musicDryFilter: BiquadFilterNode;
  private readonly musicWetFilter: BiquadFilterNode;
  private readonly musicDryGain: GainNode;
  private readonly musicWetGain: GainNode;
  private readonly sfxGain: GainNode;
  private readonly sfxWetGain: GainNode;
  private readonly vehicleFilter: BiquadFilterNode;
  private readonly vehicleGate: GainNode;
  private readonly sfxDry: GainNode;
  /** The vehicle subgraph is disconnected ("parked") while gated off, so the renderer skips it. */
  private vehicleConnected = true;
  private vehicleParkAt = Infinity;

  private mix: AudioMix;
  private scene: AudioScene;
  private lastUpdate = -1;
  private vehicleOpen = false;
  private crashed = false;
  private slowmo = false;
  /** The current slow-mo gets the full treatment (sting + filtered score): tutorial bullet time only. */
  private slowmoFx = false;
  private slowCut = 20000;
  private duckGain = -1;
  private duckCut = -1;
  /** Sim time scale (gameplay scenes; 1 elsewhere) and the matching tape-style pitch factor. */
  private simScale = 1;
  private physPitch = 1;
  private intensity = 0.3;
  private airAmt = 0;
  /** Trick-ding ladder position within the current jump. */
  private dingStep = 0;
  private nextDingAt = 0;
  private lastLandingAt = -10;
  private lastChimeAt = -10;
  private lastImpactAt = -10;
  private lastImpactStrength = 0;
  private lastClankAt = -10;
  private lastClankStrength = 0;
  private lastSlamAt = -10;
  private lastBoostAt = -10;
  private lastBoostEndAt = -10;
  private lastVacOnAt = -10;
  private lastVacOffAt = -10;
  private lastEngagedAt = -10;
  private lastReleasedAt = -10;
  private lastTakeoffAt = -10;
  private lastHoverAt = -10;
  private lastNotifyAt = -10;
  /** Level-complete fanfare still ringing (faded on restart / quit). */
  private fanfare: FadeHandle | null = null;
  /** Latest objective tick (dropped if the level completes in the same sim tick). */
  private objectiveVoice: Voice | null = null;
  private readonly warmUntil: number;

  constructor(ctx: BaseAudioContext, opts: SoundCoreOptions = {}) {
    this.ctx = ctx;
    this.warmUntil = ctx.currentTime + WARM_UP;
    this.vehicleParkAt = ctx.currentTime; // gate starts closed → park on the first tick
    this.mix = { ...(opts.mix ?? DEFAULT_MIX) };
    this.scene = opts.scene ?? 'title';
    const rng = createRng(opts.seed ?? 0x5eed);

    this.noise = {
      white: noiseBuffer(ctx, 'white', 4, 11),
      pink: noiseBuffer(ctx, 'pink', 6, 12),
      brown: noiseBuffer(ctx, 'brown', 6, 13),
      crackle: crackleBuffer(ctx, 3, 14),
    };
    const kit: SynthKit = { rng, noise: this.noise, curves: { crunch: driveCurve(4), grit: driveCurve(1.8) } };

    // --- master chain -----------------------------------------------------
    const masterIn = this.gain(MASTER_TRIM);
    const hp = this.filter('highpass', 24, 0.7);
    const glue = this.node(ctx.createDynamicsCompressor());
    glue.threshold.value = -18;
    glue.knee.value = 10;
    glue.ratio.value = 2.5;
    glue.attack.value = 0.012;
    glue.release.value = 0.28;
    const limiter = this.node(ctx.createDynamicsCompressor());
    limiter.threshold.value = -4;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.12;
    const clipPre = this.gain(1 / CLIP_RANGE);
    const clipper = this.node(ctx.createWaveShaper());
    clipper.curve = softClipCurve(4096, 0.62, 0.955, CLIP_RANGE);
    clipper.oversample = 'none'; // keeps the output strictly bounded by the curve
    this.output = this.gain(0);
    masterIn.connect(hp).connect(glue).connect(limiter).connect(clipPre).connect(clipper).connect(this.output);

    // --- reverb -------------------------------------------------------------
    const reverbIn = this.gain(1);
    const revHp = this.filter('highpass', 180, 0.7);
    const conv = this.node(ctx.createConvolver());
    conv.normalize = true;
    conv.buffer = impulseResponse(ctx, 2.4, 2.2);
    const reverbOut = this.gain(REVERB_RETURN);
    reverbIn.connect(revHp).connect(conv).connect(reverbOut).connect(masterIn);

    // --- music buses --------------------------------------------------------
    const musicDry = this.gain(1);
    const musicWet = this.gain(1);
    this.musicDryFilter = this.filter('lowpass', 20000, 0.5);
    this.musicWetFilter = this.filter('lowpass', 20000, 0.5);
    this.musicDryGain = this.gain(0);
    this.musicWetGain = this.gain(0);
    musicDry.connect(this.musicDryFilter).connect(this.musicDryGain).connect(masterIn);
    musicWet.connect(this.musicWetFilter).connect(this.musicWetGain).connect(reverbIn);

    // --- sfx buses ------------------------------------------------------------
    const sfxDry = (this.sfxDry = this.gain(1));
    const sfxWet = this.gain(1);
    this.sfxGain = this.gain(0);
    this.sfxWetGain = this.gain(0);
    sfxDry.connect(this.sfxGain).connect(masterIn);
    sfxWet.connect(this.sfxWetGain).connect(reverbIn);
    const vehicleIn = this.gain(1);
    this.vehicleFilter = this.filter('lowpass', 20000, 0.5);
    this.vehicleGate = this.gain(0);
    vehicleIn.connect(this.vehicleFilter).connect(this.vehicleGate).connect(sfxDry);

    // --- sound sources ----------------------------------------------------------
    this.sfxPool = new VoicePool(ctx, 48);
    this.uiPool = new VoicePool(ctx, 12);
    this.sfx = new SfxPlayer({ ctx, kit, pool: this.sfxPool, uiPool: this.uiPool, dry: sfxDry, wet: sfxWet });
    this.vehicle = new VehicleLayers({
      ctx,
      out: vehicleIn,
      noise: this.noise,
      rng,
      onRcsPuff: (t, pan, s) => this.sfx.rcsPuff(t, pan, s),
    });
    this.music = opts.music === false ? null : new MusicDirector({ ctx, rng, noise: this.noise, dry: musicDry, wet: musicWet });
    this.ambience = opts.music === false ? null : new SkyAmbience(ctx, this.noise.pink, musicDry, rng);

    this.applyMix(0);
    this.setScene(this.scene, true);
  }

  /* ---------------------------------------------------------------- */
  /* Public control                                                    */
  /* ---------------------------------------------------------------- */

  setMix(mix: AudioMix): void {
    this.mix = { master: mix.master, music: mix.music, sfx: mix.sfx, muted: mix.muted };
    this.applyMix(0.03);
  }

  setScene(scene: AudioScene, force = false): void {
    const prev = this.scene;
    if (!force && prev === scene) return;
    this.scene = scene;
    const t = this.ctx.currentTime;
    // Quitting to the menus right after a level-complete: fade the fanfare, let the title score in now.
    if (scene === 'title') this.endCelebration(t, 0.3);
    if (this.music) {
      if (scene === 'title') this.music.play('title', t);
      else if (scene === 'game') this.music.play('game', t);
      else if (scene === 'complete') this.music.play('complete', t);
      // 'paused' keeps the current arrangement, ducked (the gameplay score if nothing is playing yet,
      // e.g. when the context was unlocked from the pause menu).
      else if (!this.music.isRunning) this.music.play('game', t);
    }
    this.ambience?.setLevel(AMBIENCE_LEVEL * AMBIENCE_BY_SCENE[scene], t, force ? 0.8 : 1.5);
    if (scene !== 'game' && scene !== 'paused') {
      // Leaving gameplay: drop transient gameplay state so menus are never left ducked or filtered.
      this.crashed = false;
      this.slowmo = false;
      this.slowmoFx = false;
      this.simScale = 1;
      this.physPitch = 1;
    }
    this.applyMusicDuck(t, scene === 'paused' || prev === 'paused' ? 0.12 : 0.4);
    if (scene !== 'game') this.setVehicleOpen(false, t);
  }

  /** Per rendered frame. */
  update(frame: RenderFrame): void {
    const t = this.ctx.currentTime;
    const dt = clamp(Number.isFinite(frame.dt) ? frame.dt : 1 / 60, 0, 0.1);
    this.lastUpdate = t;
    const snap = frame.snapshot;
    const v = snap.vehicle;
    const live = this.scene === 'game' && !frame.paused;
    this.setVehicleOpen(live, t);
    this.parkVehicle(t);
    if (live) this.vehicle.update(frame, t, dt);

    // Slow motion: physical one-shots pitch down and the vehicle bus darkens. Gameplay scenes only: the
    // runner leaves runtime.frame pointing at the last snapshot when a run ends, and a stale timeScale
    // must never muffle the menus.
    const gameplay = this.scene === 'game' || this.scene === 'paused';
    const ts = gameplay ? clamp(Number.isFinite(snap.timeScale) && snap.timeScale > 0 ? snap.timeScale : 1, 0.05, 1) : 1;
    this.simScale = ts;
    this.physPitch = Math.sqrt(Math.max(0.15, ts));
    const crashed = snap.phase === 'crashed' || v.crashed;
    if (!this.slowmo && ts < 0.6) {
      this.slowmo = true;
      // Bullet time (tutorial prompts) gets the full treatment: a "time slows" sting and a filtered score.
      // A crash, or the short reward slow-mo the sim requests after a PERFECT landing, keeps only the
      // physical pitch drop: their own sounds are the cue (a sub drop under the PERFECT chime muddies it).
      this.slowmoFx = live && !crashed && t - this.lastLandingAt > 0.4;
      if (this.slowmoFx) this.sfx.slowmoIn(t + 0.005);
      this.applyMusicDuck(t, 0.3);
    } else if (this.slowmo && ts > 0.9) {
      this.slowmo = false;
      if (this.slowmoFx && live && !crashed) this.sfx.slowmoOut(t + 0.005);
      this.slowmoFx = false;
      this.applyMusicDuck(t, 0.3);
    }
    const cut = 1800 + 18200 * smoothstep(0.3, 1, ts);
    if (Math.abs(cut - this.slowCut) > this.slowCut * 0.03) {
      this.slowCut = cut;
      glide(this.vehicleFilter.frequency, cut, t, 0.08);
    }

    // Score intensity: base cruise + speed + airborne + boost; low after a crash.
    if (this.music && live) {
      const airT = v.airborne ? 1 : 0;
      this.airAmt += (airT - this.airAmt) * smoothK(dt, airT > this.airAmt ? 0.3 : 1.0);
      const target = crashed
        ? 0.12
        : clamp(0.3 + 0.14 * clamp(fin(v.speed) / 57, 0, 1) + 0.36 * this.airAmt + 0.25 * clamp(fin(v.boostLevel), 0, 1), 0, 1);
      this.intensity += (target - this.intensity) * smoothK(dt, target > this.intensity ? 0.8 : 2.2);
      this.music.setDrive(this.intensity, this.airAmt, t);
      if (v.airborne && fin(snap.air.airTime) > 0.6 && !crashed) this.music.enterFlight();
    }
    this.music?.schedule(t);
  }

  /** Timer tick (live) — keeps the score scheduled and closes the vehicle bus if frames stop. */
  tick(): void {
    const t = this.ctx.currentTime;
    if (this.vehicleOpen && t - this.lastUpdate > 0.35) this.setVehicleOpen(false, t);
    this.parkVehicle(t);
    this.music?.schedule(t);
  }

  handleEvent(e: GameEvent): void {
    // Gameplay one-shots never sound on the title screen (e.g. an attract-mode sim behind the menu).
    if (this.scene === 'title') return;
    const t = Math.max(this.ctx.currentTime + 0.005, this.warmUntil);
    const p = this.physPitch;
    const sfx = this.sfx;
    // Toggle-style events are debounced (the timestamp moves even when the sound is skipped), so button
    // mashing or sensor flicker (vacuum engage at the edge of its range) cannot stack voices.
    switch (e.type) {
      case 'reset':
        this.crashed = false;
        this.dingStep = 0;
        this.vehicle.reset(t);
        this.music?.exitFlight();
        this.endCelebration(t, 0.12);
        this.applyMusicDuck(t, 0.8);
        sfx.resetWhoosh(t);
        break;
      case 'takeoff':
        this.dingStep = 0;
        if (t - this.lastTakeoffAt > 0.5) sfx.takeoff(t, fin(e.speed));
        this.lastTakeoffAt = t;
        break;
      case 'landing': {
        const q = e.result.quality;
        // Wheel slams of this touchdown already sounded (see SLAM_BEFORE_LANDING): keep the low thud light.
        const slammed = t - this.lastSlamAt < SLAM_BEFORE_LANDING;
        const body = !slammed ? 1 : q === 'hard' || q === 'crash' ? 0.5 : 0.3;
        this.lastLandingAt = t;
        this.dingStep = 0;
        sfx.landing(t, q, fin(e.result.impactSpeed, 8), p, body);
        if (q === 'perfect') this.lastChimeAt = t;
        if (q === 'crash') this.music?.exitFlight();
        else this.music?.resolve(t);
        break;
      }
      case 'crash':
        this.crashed = true;
        this.music?.exitFlight();
        this.applyMusicDuck(t, 0.2);
        sfx.crash(t, fin(e.impactSpeed, 20), p);
        break;
      case 'trick': {
        // The sim emits one event per completed rotation (a DOUBLE is a second event with count 2) plus
        // bonuses (HANG TIME, BULLSEYE, INVERTED): every ding climbs at least one ladder step, and a
        // multi-rotation trick reported at once jumps straight to its count.
        this.dingStep = Math.max(this.dingStep + 1, Math.round(clamp(fin(e.trick.count, 1), 1, 8)));
        const at = Math.max(t, this.nextDingAt);
        this.nextDingAt = at + 0.09;
        sfx.trickDing(at, this.dingStep);
        break;
      }
      case 'boostStart':
        if (t - this.lastBoostAt > 0.12) sfx.boostIgnition(t, p);
        this.lastBoostAt = t;
        break;
      case 'boostEnd':
        if (t - this.lastBoostEndAt > 0.12) sfx.boostCutoff(t, p);
        this.lastBoostEndAt = t;
        break;
      case 'fuelEmpty':
        sfx.fuelSputter(t);
        break;
      case 'vacuumOn':
        if (t - this.lastVacOnAt > 0.2) sfx.vacuumOn(t);
        this.lastVacOnAt = t;
        break;
      case 'vacuumOff':
        if (t - this.lastVacOffAt > 0.15) sfx.vacuumOff(t);
        this.lastVacOffAt = t;
        break;
      case 'vacuumEngaged':
        if (t - this.lastEngagedAt > 0.25) sfx.vacuumEngaged(t);
        this.lastEngagedAt = t;
        break;
      case 'vacuumReleased':
        if (t - this.lastReleasedAt > 0.25) sfx.vacuumReleased(t);
        this.lastReleasedAt = t;
        break;
      case 'impact': {
        const s = clamp(fin(e.strength), 0, 1);
        // A sustained scrape arrives as a report every ~0.1 s (sim time): those keep the scrape layer
        // going. A clank one-shot marks a new contact, or a hit clearly harder than the last clank.
        const sustained = (t - this.lastImpactAt) * this.simScale < SCRAPE_CONTINUITY;
        const previous = sustained ? this.lastImpactStrength : 0;
        this.lastImpactAt = t;
        this.lastImpactStrength = s;
        // Only while the vehicle bus is live: a closed bus does not advance the layer (a new level emits
        // no 'reset'), so a scrape fed now would resurface when the next run opens the bus.
        if (this.vehicleOpen) this.vehicle.addImpact(s, sustained);
        const sinceClank = t - this.lastClankAt;
        // "Harder" is relative to the ongoing scrape and to the (fading) memory of the last clank.
        const reference = Math.max(previous, this.lastClankStrength * Math.exp(-sinceClank / 0.5));
        if (!sustained || (sinceClank > 0.06 && s > Math.max(0.25, reference * 1.5))) {
          this.lastClankAt = t;
          this.lastClankStrength = s;
          sfx.impact(t, s, p);
        }
        break;
      }
      case 'wheelSlam':
        if (t - this.lastSlamAt < 0.07) break;
        this.lastSlamAt = t;
        sfx.wheelSlam(t, clamp(fin(e.strength), 0, 1) * (t - this.lastLandingAt < 0.15 ? 0.5 : 1), p);
        break;
      case 'objectiveComplete':
        if (t - this.lastChimeAt < 0.3 || t - this.lastLandingAt < 0.25) break;
        this.lastChimeAt = t;
        this.objectiveVoice = sfx.objectiveTick(t);
        break;
      case 'checkpoint':
        sfx.checkpoint(t);
        break;
      case 'prompt':
        // The sim often completes an objective and raises the next prompt in the same tick: one cue is
        // enough, so the notify yields to an objective tick / landing chime that just played.
        if (e.prompt && (e.prompt.tone === 'action' || e.prompt.tone === 'warning') && t - this.lastNotifyAt > 0.6 && t - this.lastChimeAt > 0.3) {
          this.lastNotifyAt = t;
          sfx.notify(t);
        }
        break;
      case 'levelComplete': {
        // The final objective completes in the same sim tick as the level: its tick (not started yet)
        // would only clutter the fanfare's downbeat.
        const ov = this.objectiveVoice;
        if (ov && !ov.isFinished && ov.startTime > this.ctx.currentTime) ov.cancel();
        this.objectiveVoice = null;
        // Let a landing chime breathe before the fanfare enters.
        const at = t - this.lastLandingAt < 0.5 ? this.lastLandingAt + 0.5 : t;
        this.lastChimeAt = at;
        this.music?.holdFor(t, at - t + 3.3);
        this.fanfare?.fade(t, 0.1);
        this.fanfare = sfx.fanfare(at);
        break;
      }
      case 'objective':
      case 'zoneEnter':
        break;
    }
  }

  ui(kind: UiSound): void {
    const t = Math.max(this.ctx.currentTime + 0.003, this.warmUntil);
    if (kind === 'hover') {
      if (t - this.lastHoverAt < 0.035) return;
      this.lastHoverAt = t;
    }
    this.sfx.ui(kind, t);
  }

  /** Test hook: solo one vehicle layer. */
  soloLayer(name: LayerName | null): void {
    this.vehicle.setSolo(name);
  }

  /** Test hook: hear only these vehicle layers (null = all). */
  maskLayers(names: readonly LayerName[] | null): void {
    this.vehicle.setMask(names);
  }

  /** Analyser tapped after the master stage (dev meters / live verification). */
  createAnalyser(fftSize = 2048): AnalyserNode {
    const a = this.ctx.createAnalyser();
    a.fftSize = fftSize;
    a.smoothingTimeConstant = 0.6;
    this.output.connect(a);
    this.nodes.push(a);
    return a;
  }

  get debug(): CoreDebug {
    return {
      scene: this.scene,
      intensity: this.intensity,
      air: this.airAmt,
      vehicleOpen: this.vehicleOpen,
      slowmo: this.slowmo,
      crashed: this.crashed,
      sfxVoices: this.sfxPool.size,
      uiVoices: this.uiPool.size,
      music: this.music?.debug ?? null,
    };
  }

  dispose(): void {
    this.music?.dispose();
    this.ambience?.dispose();
    this.vehicle.dispose();
    this.sfxPool.cancelAll();
    this.uiPool.cancelAll();
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.nodes.length = 0;
  }

  /* ---------------------------------------------------------------- */

  private applyMix(tc: number): void {
    const t = this.ctx.currentTime;
    const m = this.mix;
    const master = m.muted ? 0 : sliderToGain(m.master);
    const sfx = sliderToGain(m.sfx);
    if (tc <= 0) {
      this.output.gain.value = master;
      this.sfxGain.gain.value = sfx;
      this.sfxWetGain.gain.value = sfx;
    } else {
      glide(this.output.gain, master, t, tc);
      glide(this.sfxGain.gain, sfx, t, tc);
      glide(this.sfxWetGain.gain, sfx, t, tc);
    }
    this.duckGain = -1; // force re-apply with the new music volume
    this.applyMusicDuck(t, tc);
  }

  /** Restart / quit to the menus: fade a still-ringing level-complete fanfare and lift the score's hold. */
  private endCelebration(t: number, tc: number): void {
    this.fanfare?.fade(t, tc);
    this.fanfare = null;
    this.music?.cancelHold(t);
  }

  /** Combine scene / crash / slow-mo into the score's gain and lowpass (only on state changes). */
  private applyMusicDuck(t: number, tc: number): void {
    let gain = 1;
    let cutoff = 20000;
    if (this.scene === 'paused') {
      gain = 0.5;
      cutoff = 700;
    }
    if (this.crashed && (this.scene === 'game' || this.scene === 'paused')) {
      gain = Math.min(gain, 0.4);
      cutoff = Math.min(cutoff, 500);
    }
    if (this.slowmo && this.slowmoFx && !this.crashed) {
      gain *= 0.85;
      cutoff = Math.min(cutoff, 2400);
    }
    const g = gain * sliderToGain(this.mix.music);
    if (g !== this.duckGain) {
      this.duckGain = g;
      if (tc <= 0) {
        this.musicDryGain.gain.value = g;
        this.musicWetGain.gain.value = g;
      } else {
        glide(this.musicDryGain.gain, g, t, tc);
        glide(this.musicWetGain.gain, g, t, tc);
      }
    }
    if (cutoff !== this.duckCut) {
      this.duckCut = cutoff;
      if (tc <= 0) {
        this.musicDryFilter.frequency.value = cutoff;
        this.musicWetFilter.frequency.value = cutoff;
      } else {
        glide(this.musicDryFilter.frequency, cutoff, t, tc);
        glide(this.musicWetFilter.frequency, cutoff, t, tc);
      }
    }
  }

  private setVehicleOpen(open: boolean, t: number): void {
    if (open === this.vehicleOpen) return;
    this.vehicleOpen = open;
    const tc = open ? 0.05 : this.scene === 'complete' ? 0.6 : 0.06;
    if (open) {
      this.vehicleParkAt = Infinity;
      if (!this.vehicleConnected) {
        this.vehicleGate.connect(this.sfxDry);
        this.vehicleConnected = true;
      }
    } else {
      this.vehicleParkAt = t + tc * 6; // gate is at -52 dB by then
    }
    glide(this.vehicleGate.gain, open ? 1 : 0, t, tc);
  }

  /** Disconnect the silent vehicle subgraph (≈1.8 % CPU) once its gate has fully closed. */
  private parkVehicle(t: number): void {
    if (this.vehicleConnected && !this.vehicleOpen && t >= this.vehicleParkAt) {
      this.vehicleGate.disconnect();
      this.vehicleConnected = false;
    }
  }

  private node<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  private gain(v: number): GainNode {
    const g = this.node(this.ctx.createGain());
    g.gain.value = v;
    return g;
  }

  private filter(type: BiquadFilterType, f: number, q: number): BiquadFilterNode {
    const n = this.node(this.ctx.createBiquadFilter());
    n.type = type;
    n.frequency.value = f;
    n.Q.value = q;
    return n;
  }
}
