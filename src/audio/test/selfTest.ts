/**
 * Objective audio verification (we cannot listen in CI): every sound is rendered through the *real*
 * SoundCore graph on an OfflineAudioContext and measured.
 *
 *  - one-shots / UI: non-silent, peak < 0.98 after the master limiter, spectral centroid + band split
 *  - continuous layers: parameter sweeps (solo) driven at ~31 Hz through suspend()/resume(); each must
 *    respond in the expected direction (louder / brighter / silent when it should be)
 *  - music: every arrangement, low vs high intensity, pause ducking
 *  - worst case: full mix at maximum volumes with every layer maxed + simultaneous big one-shots
 *  - mock run: 14 s of the scripted MockSim (all its events) through the default mix
 *  - live: the singleton on a real AudioContext (API smoke test + analyser peak)
 *
 * Dev tooling only (imported by dev/audio.tsx).
 */
import { Quaternion, Vector3 } from 'three';
import { createSnapshot } from '@/game/snapshot';
import type { GameEvent, LandingQuality, LandingResult, LevelResult, RenderFrame, VacuumMode } from '@/game/types';
import { MockSim } from '@/dev/mockRuntime';
import { SoundCore } from '../core/SoundCore';
import { VoicePool } from '../dsp/voice';
import { LAYER_NAMES, type LayerName } from '../layers/VehicleLayers';
import { DEFAULT_MIX, type AudioMix, type AudioScene, type UiSound } from '../types';
import { audio, AudioEngine } from '../AudioEngine';
import { analyze, clicksOf, dominantHzOf, envelopeSpreadOf, loudnessOf, lowBandDbOf, peakOf, rmsDbOf, spectrumOf, type Bands } from './analysis';

const SR = 48000;
/** Update period: 12 render quanta (32 ms) so every suspend() lands on a distinct quantum. */
const FRAME = (128 * 12) / SR;
/**
 * Silence rendered before each test so the master DynamicsCompressors reach steady state (they start
 * attenuated and ramp their makeup gain in over ~0.3 s). A whole number of frames.
 */
const PRE_ROLL = 12 * FRAME;
const FULL_MIX: AudioMix = { master: 1, music: 1, sfx: 1, muted: false };
const CLIP_LIMIT = 0.98;
const SILENT_PEAK = 0.003;
/** RMS below which a window counts as silent. */
const SILENT_DB = -60;

export interface SoundResult {
  name: string;
  group: 'event' | 'ui' | 'internal' | 'music' | 'mix';
  peak: number;
  /** BS.1770 momentary max (LUFS). */
  lufsM: number;
  /** BS.1770 gated integrated (LUFS). */
  lufsI: number;
  /** Transient loudness (100 ms window, LUFS). */
  lufsT: number;
  /** Transient loudness through a simulated laptop speaker (LUFS). */
  lufsSmall: number;
  rmsDb: number;
  activeMs: number;
  centroidHz: number;
  bands: Bands;
  pass: boolean;
  issues: string[];
}

export interface LayerPoint {
  label: string;
  rmsDb: number;
  centroidHz: number;
  /** Energy in the 300 Hz – 6 kHz "presence" range (dB) — tracks arps / hats / lift layers. */
  presenceDb?: number;
  /** BS.1770 integrated loudness of the window (LUFS). */
  lufs?: number;
}

export interface LayerResult {
  name: string;
  points: LayerPoint[];
  peak: number;
  pass: boolean;
  detail: string;
}

export interface LiveResult {
  state: string;
  contextTime: number;
  analyserPeak: number;
  /** Context state after a simulated `visibilitychange` to hidden, then back to visible. */
  hiddenState: string;
  visibleState: string;
  /** unlock → dispose → unlock on a separate engine instance. */
  lifecycle: string;
  /** Context state while muted (should suspend) and after unmuting (should resume). */
  mute: string;
  errors: string[];
}

export interface SelfTestReport {
  ok: boolean;
  sampleRate: number;
  elapsedMs: number;
  sounds: SoundResult[];
  layers: LayerResult[];
  live: LiveResult | null;
  failures: string[];
}

/* ------------------------------------------------------------------ */
/* Frames & events                                                     */
/* ------------------------------------------------------------------ */

function makeFrame(): RenderFrame {
  const snapshot = createSnapshot(3);
  snapshot.phase = 'running';
  snapshot.vehicle.vacuum.available = true;
  return { position: new Vector3(), quaternion: new Quaternion(), snapshot, alpha: 1, dt: FRAME, simDt: FRAME, time: 0, paused: false };
}

interface DriveSpec {
  speed?: number;
  throttle?: number;
  slip?: number;
  airborne?: boolean;
  boost?: number;
  angVel?: number;
  rcs?: number;
  vacMode?: VacuumMode;
  vacStrength?: number;
  timeScale?: number;
  paused?: boolean;
}

/** Fully specify the vehicle state for this frame (unspecified fields return to defaults). */
function drive(f: RenderFrame, o: DriveSpec): void {
  const v = f.snapshot.vehicle;
  const speed = o.speed ?? 0;
  const airborne = o.airborne ?? false;
  v.speed = speed;
  v.forwardSpeed = speed;
  v.velocity.set(0, 0, -speed);
  for (const w of v.wheels) {
    w.grounded = !airborne;
    w.spinRate = speed / 0.36;
    w.slip = airborne ? 0 : (o.slip ?? 0);
    w.surface = airborne ? null : 'asphalt';
  }
  v.groundedWheels = airborne ? 0 : 4;
  v.airborne = airborne;
  v.throttle = airborne ? 0 : (o.throttle ?? 0);
  v.boostLevel = o.boost ?? 0;
  v.boosting = v.boostLevel > 0.05;
  v.angularVelocity.set(o.angVel ?? 0, 0, 0);
  v.rcs.pitch = o.rcs ?? 0;
  v.rcs.yaw = 0;
  v.rcs.roll = 0;
  v.vacuum.mode = o.vacMode ?? 'off';
  v.vacuum.strength = o.vacStrength ?? 0;
  f.snapshot.timeScale = o.timeScale ?? 1;
  f.snapshot.air.airborne = airborne;
  f.snapshot.air.airTime = airborne ? 2 : 0;
  f.paused = o.paused ?? false;
}

const P0 = new Vector3(0, 0.36, -100);
const UP = new Vector3(0, 1, 0);

function landing(quality: LandingQuality, impactSpeed: number): LandingResult {
  return {
    quality,
    angleDeg: 4,
    impactSpeed,
    driftDeg: 2,
    wheelsDown: 4,
    airTime: 3,
    distance: 120,
    maxHeight: 14,
    tricks: [],
    basePoints: 1000,
    multiplier: 2,
    points: 2000,
    inTarget: true,
    position: P0.clone(),
  };
}

function levelResult(): LevelResult {
  return {
    levelId: 1,
    score: 12000,
    time: 62,
    medal: 'gold',
    finalLanding: landing('perfect', 5),
    bestLanding: null,
    breakdown: [],
    stats: { maxSpeedKmh: 250, maxAirTime: 4, longestJump: 160, tricks: 3, invertedDistance: 0 },
  };
}

const trick = (count: number): GameEvent => ({ type: 'trick', trick: { kind: 'backflip', label: 'BACKFLIP', count, points: 600 } });

/* ------------------------------------------------------------------ */
/* Offline rendering                                                   */
/* ------------------------------------------------------------------ */

interface RenderSpec {
  /** Scenario duration (after the pre-roll). */
  duration: number;
  scene?: AudioScene;
  music?: boolean;
  mix?: AudioMix;
  solo?: LayerName | null;
  /** Audible vehicle layers (overrides `solo`). */
  mask?: readonly LayerName[];
  /** At scenario t = 0, i.e. right after the pre-roll (fire one-shots here). */
  setup?: (core: SoundCore, frame: RenderFrame) => void;
  /** Every FRAME seconds with scenario time t (negative during the pre-roll), before core.update(frame). */
  step?: (t: number, frame: RenderFrame, core: SoundCore) => void;
  /** After rendering (pending `ended` events flushed), before the core is disposed. */
  after?: (core: SoundCore) => void;
}

/** A rendered scenario. `at(t)` maps scenario time to buffer time. */
interface Rendered {
  buf: AudioBuffer;
  /** Buffer time of scenario t = 0. */
  start: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`${what}: timeout after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function render(spec: RenderSpec, errors: string[]): Promise<Rendered> {
  const total = PRE_ROLL + spec.duration;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(total * SR), sampleRate: SR });
  const core = new SoundCore(ctx, { mix: spec.mix ?? FULL_MIX, scene: spec.scene ?? 'game', music: spec.music ?? false });
  core.output.connect(ctx.destination);
  if (spec.solo !== undefined) core.soloLayer(spec.solo);
  if (spec.mask) core.maskLayers(spec.mask);
  const frame = makeFrame();
  const guard = (fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      errors.push(errText(e));
    }
  };
  let setupDone = !spec.setup;
  const runSetup = (): void => {
    if (setupDone) return;
    setupDone = true;
    guard(() => spec.setup?.(core, frame));
  };
  const at = (clock: number, fn: () => void): void => {
    ctx
      .suspend(clock)
      .then(() => {
        fn();
        return ctx.resume();
      })
      .catch((e: unknown) => errors.push(`suspend@${clock.toFixed(3)}: ${errText(e)}`));
  };
  if (spec.step || spec.music) {
    const tick = (clock: number): void =>
      guard(() => {
        const t = clock - PRE_ROLL;
        if (t >= -1e-9) runSetup();
        frame.time = clock;
        frame.dt = FRAME;
        frame.simDt = FRAME * frame.snapshot.timeScale;
        spec.step?.(t, frame, core);
        core.update(frame);
        core.tick();
      });
    tick(0);
    for (let k = 1; (k + 1) * FRAME < total; k++) {
      const clock = k * FRAME;
      at(clock, () => tick(clock));
    }
  } else if (spec.setup) {
    at(PRE_ROLL, runSetup);
  }
  const buf = await withTimeout(ctx.startRendering(), 30000, 'render');
  if (spec.after) {
    await new Promise<void>((res) => setTimeout(res, 40)); // let queued `ended` events dispatch
    guard(() => spec.after?.(core));
  }
  guard(() => core.dispose());
  return { buf, start: PRE_ROLL };
}

/* ------------------------------------------------------------------ */
/* Test tables                                                         */
/* ------------------------------------------------------------------ */

/** Anything that accepts game events and UI sounds (SoundCore offline, the `audio` singleton live). */
interface SoundTarget {
  handleEvent(e: GameEvent): void;
  ui(kind: UiSound): void;
}

interface OneShotCase {
  name: string;
  group: SoundResult['group'];
  duration: number;
  event?: GameEvent;
  ui?: UiSound;
  /** Internal sounds without a public trigger (offline only). */
  internal?: (core: SoundCore) => void;
}

const ev = (e: GameEvent): Pick<OneShotCase, 'event'> => ({ event: e });
const ui = (k: UiSound): Pick<OneShotCase, 'ui'> => ({ ui: k });

/** Fire a case's public trigger on a target; returns false when the case is internal-only. */
function firePublic(c: OneShotCase, target: SoundTarget): boolean {
  if (c.event) target.handleEvent(c.event);
  else if (c.ui) target.ui(c.ui);
  else return false;
  return true;
}

const ONE_SHOTS: OneShotCase[] = [
  { name: 'boostStart', group: 'event', duration: 1.5, ...ev({ type: 'boostStart' }) },
  { name: 'boostEnd', group: 'event', duration: 1.2, ...ev({ type: 'boostEnd' }) },
  { name: 'fuelEmpty', group: 'event', duration: 1.8, ...ev({ type: 'fuelEmpty' }) },
  { name: 'vacuumOn', group: 'event', duration: 1.8, ...ev({ type: 'vacuumOn' }) },
  { name: 'vacuumEngaged', group: 'event', duration: 1.4, ...ev({ type: 'vacuumEngaged', position: P0, normal: UP }) },
  { name: 'vacuumReleased', group: 'event', duration: 1.6, ...ev({ type: 'vacuumReleased', position: P0 }) },
  { name: 'vacuumOff', group: 'event', duration: 1.2, ...ev({ type: 'vacuumOff' }) },
  { name: 'takeoff', group: 'event', duration: 1.5, ...ev({ type: 'takeoff', position: P0, speed: 45 }) },
  { name: 'trick x1', group: 'event', duration: 2, ...ev(trick(1)) },
  { name: 'trick x3', group: 'event', duration: 2, ...ev(trick(3)) },
  { name: 'trick x6', group: 'event', duration: 2, ...ev(trick(6)) },
  { name: 'landing PERFECT', group: 'event', duration: 3, ...ev({ type: 'landing', result: landing('perfect', 5) }) },
  { name: 'landing CLEAN', group: 'event', duration: 1.6, ...ev({ type: 'landing', result: landing('clean', 11) }) },
  { name: 'landing HARD', group: 'event', duration: 1.8, ...ev({ type: 'landing', result: landing('hard', 20) }) },
  { name: 'landing CRASH', group: 'event', duration: 1.8, ...ev({ type: 'landing', result: landing('crash', 28) }) },
  { name: 'wheelSlam 0.35', group: 'event', duration: 1, ...ev({ type: 'wheelSlam', position: P0, strength: 0.35 }) },
  { name: 'wheelSlam 1.0', group: 'event', duration: 1, ...ev({ type: 'wheelSlam', position: P0, strength: 1 }) },
  { name: 'impact 0.3', group: 'event', duration: 1.2, ...ev({ type: 'impact', position: P0, normal: UP, strength: 0.3 }) },
  { name: 'impact 1.0', group: 'event', duration: 1.4, ...ev({ type: 'impact', position: P0, normal: UP, strength: 1 }) },
  { name: 'crash', group: 'event', duration: 4, ...ev({ type: 'crash', reason: 'rollover', position: P0, impactSpeed: 24 }) },
  { name: 'objectiveComplete', group: 'event', duration: 1.4, ...ev({ type: 'objectiveComplete', index: 0, id: 'o' }) },
  { name: 'checkpoint', group: 'event', duration: 1.2, ...ev({ type: 'checkpoint', id: 'c' }) },
  { name: 'prompt', group: 'event', duration: 1.4, ...ev({ type: 'prompt', prompt: { id: 'p', text: 'HOLD SPACE', hint: null, tone: 'action' } }) },
  { name: 'levelComplete', group: 'event', duration: 5.5, ...ev({ type: 'levelComplete', result: levelResult() }) },
  { name: 'reset', group: 'event', duration: 1.5, ...ev({ type: 'reset' }) },
  { name: 'ui hover', group: 'ui', duration: 0.6, ...ui('hover') },
  { name: 'ui click', group: 'ui', duration: 0.8, ...ui('click') },
  { name: 'ui back', group: 'ui', duration: 0.9, ...ui('back') },
  { name: 'ui toggle', group: 'ui', duration: 0.8, ...ui('toggle') },
  { name: 'ui start', group: 'ui', duration: 3, ...ui('start') },
  { name: 'ui unlock', group: 'ui', duration: 2.6, ...ui('unlock') },
  { name: 'rcs puff', group: 'internal', duration: 0.8, internal: (c) => c.sfx.rcsPuff(c.ctx.currentTime + 0.005, 0.3, 1) },
  { name: 'slowmo in', group: 'internal', duration: 2, internal: (c) => c.sfx.slowmoIn(c.ctx.currentTime + 0.005) },
  { name: 'slowmo out', group: 'internal', duration: 1.2, internal: (c) => c.sfx.slowmoOut(c.ctx.currentTime + 0.005) },
];

interface LayerCase {
  name: string;
  solo: LayerName | null;
  mask?: readonly LayerName[];
  duration: number;
  scene?: AudioScene;
  step: (t: number, f: RenderFrame, core: SoundCore) => void;
  windows: Array<[label: string, from: number, to: number]>;
  /** Returns a failure description, or null when the response is as expected. */
  check: (p: Record<string, LayerPoint>) => string | null;
  /** Also require zero clicks over this scenario window. */
  clickWindow?: [from: number, to: number];
}

const louder = (a: LayerPoint, b: LayerPoint, db: number): boolean => a.rmsDb > b.rmsDb + db;
const silent = (a: LayerPoint): boolean => a.rmsDb < SILENT_DB;
const audible = (a: LayerPoint): boolean => a.rmsDb > -55;

const LAYERS: LayerCase[] = [
  {
    name: 'motor whine (speed & throttle)',
    solo: 'motor',
    duration: 4,
    step: (t, f) => drive(f, t < 1 ? { speed: 5, throttle: 1 } : t < 2 ? { speed: 30, throttle: 1 } : t < 3 ? { speed: 55, throttle: 1 } : { speed: 55, throttle: 0 }),
    windows: [
      ['5 m/s full', 0.5, 0.95],
      ['30 m/s full', 1.5, 1.95],
      ['55 m/s full', 2.5, 2.95],
      ['55 m/s coast', 3.5, 3.95],
    ],
    check: (p) =>
      !audible(p['5 m/s full'])
        ? 'inaudible at low speed'
        : !louder(p['55 m/s full'], p['5 m/s full'], 3)
          ? 'not louder with speed'
          : p['55 m/s full'].centroidHz < p['5 m/s full'].centroidHz * 1.5
            ? 'pitch does not rise with speed'
            : !louder(p['55 m/s full'], p['55 m/s coast'], 2)
              ? 'throttle load has no effect'
              : null,
  },
  {
    name: 'wind (∝ speed²)',
    solo: 'wind',
    duration: 3,
    step: (t, f) => drive(f, { speed: t < 1 ? 10 : t < 2 ? 40 : 80 }),
    windows: [
      ['10 m/s', 0.5, 0.95],
      ['40 m/s', 1.5, 1.95],
      ['80 m/s', 2.5, 2.95],
    ],
    check: (p) => (!louder(p['40 m/s'], p['10 m/s'], 8) ? '10→40 m/s rise too small' : !louder(p['80 m/s'], p['40 m/s'], 5) ? '40→80 m/s rise too small' : null),
  },
  {
    name: 'road rumble (grounded only)',
    solo: 'road',
    duration: 3,
    step: (t, f) => drive(f, t < 1 ? { speed: 10 } : t < 2 ? { speed: 40 } : { speed: 40, airborne: true }),
    windows: [
      ['10 m/s', 0.5, 0.95],
      ['40 m/s', 1.5, 1.95],
      ['airborne', 2.5, 2.95],
    ],
    check: (p) => (!louder(p['40 m/s'], p['10 m/s'], 5) ? 'no rise with speed' : !louder(p['40 m/s'], p.airborne, 15) ? 'does not drop out in the air' : null),
  },
  {
    name: 'tyre squeal (slip)',
    solo: 'squeal',
    duration: 3,
    step: (t, f) => drive(f, { speed: 20, throttle: 0.5, slip: t < 1 ? 0 : t < 2 ? 0.5 : 1 }),
    windows: [
      ['slip 0', 0.5, 0.95],
      ['slip 0.5', 1.5, 1.95],
      ['slip 1', 2.5, 2.95],
    ],
    check: (p) => (!silent(p['slip 0']) ? 'squeals without slip' : !audible(p['slip 1']) ? 'inaudible at full slip' : !louder(p['slip 1'], p['slip 0.5'], 1) ? 'no rise with slip' : null),
  },
  {
    name: 'rocket roar (boostLevel)',
    solo: 'rocket',
    duration: 3,
    step: (t, f) => drive(f, { speed: 30, throttle: 1, boost: t < 1 ? 0 : t < 2 ? 0.5 : 1 }),
    windows: [
      ['boost 0', 0.5, 0.95],
      ['boost 0.5', 1.5, 1.95],
      ['boost 1', 2.5, 2.95],
    ],
    check: (p) => (!silent(p['boost 0']) ? 'roars without boost' : !audible(p['boost 0.5']) ? 'inaudible at half boost' : !louder(p['boost 1'], p['boost 0.5'], 2) ? 'no rise with boost' : null),
  },
  {
    name: 'RCS hiss (axes)',
    solo: 'rcs',
    duration: 3,
    step: (t, f) => drive(f, { speed: 30, airborne: true, rcs: t < 1 ? 0 : t < 2 ? 0.5 : 1 }),
    windows: [
      ['rcs 0', 0.5, 0.95],
      ['rcs 0.5', 1.5, 1.95],
      ['rcs 1', 2.5, 2.95],
    ],
    check: (p) => (!silent(p['rcs 0']) ? 'hisses at rest' : !audible(p['rcs 0.5']) ? 'inaudible at half' : !louder(p['rcs 1'], p['rcs 0.5'], 1) ? 'no rise with activity' : null),
  },
  {
    name: 'vacuum turbine (mode / strength)',
    solo: 'vacuum',
    duration: 5,
    step: (t, f) =>
      drive(f, t < 1 ? { speed: 20 } : t < 2 ? { speed: 20, vacMode: 'armed' } : t < 3.5 ? { speed: 20, vacMode: 'engaged', vacStrength: 1 } : { speed: 20 }),
    windows: [
      ['off', 0.5, 0.95],
      ['armed', 1.6, 1.95],
      ['engaged', 3.0, 3.45],
      ['spin-down', 3.6, 3.9],
    ],
    check: (p) =>
      !silent(p.off)
        ? 'audible when off'
        : !audible(p.armed)
          ? 'inaudible when armed'
          : !louder(p.engaged, p.armed, 2)
            ? 'engaged not louder than armed'
            : p.engaged.centroidHz <= p.armed.centroidHz
              ? 'whine does not rise when engaged'
              : !louder(p.engaged, p['spin-down'], 0.5)
                ? 'no spin-down'
                : null,
  },
  {
    name: 'airborne whoosh (rotation)',
    solo: 'air',
    duration: 3,
    step: (t, f) => drive(f, t < 1 ? { speed: 40 } : t < 2 ? { speed: 40, airborne: true } : { speed: 40, airborne: true, angVel: 6 }),
    windows: [
      ['grounded', 0.5, 0.95],
      ['air, still', 1.5, 1.95],
      ['air, flipping', 2.3, 2.95],
    ],
    check: (p) =>
      !silent(p.grounded) ? 'whooshes on the ground' : !audible(p['air, still']) ? 'inaudible in the air' : !louder(p['air, flipping'], p['air, still'], 2) ? 'rotation has no effect' : null,
  },
  {
    name: 'scrape (impact feed)',
    solo: 'scrape',
    duration: 2.4,
    step: (t, f, core) => {
      drive(f, { speed: 20 });
      if (t < 1) core.vehicle.addImpact(0.9);
    },
    windows: [
      ['scraping', 0.3, 0.9],
      ['after', 1.7, 2.3],
    ],
    check: (p) => (!audible(p.scraping) ? 'inaudible while scraping' : !silent(p.after) ? 'does not decay' : null),
  },
  {
    name: 'pause silences continuous layers',
    solo: null,
    duration: 2.5,
    step: (t, f) => drive(f, { speed: 50, throttle: 1, boost: 1, slip: 0.8, vacMode: 'engaged', vacStrength: 1, paused: t >= 1.2 }),
    windows: [
      ['playing', 0.6, 1.1],
      ['paused', 1.6, 2.4],
    ],
    check: (p) => (!audible(p.playing) ? 'inaudible while playing' : !silent(p.paused) ? 'still audible when paused' : null),
  },
  {
    name: 'slow motion pitches down',
    solo: 'motor',
    duration: 3,
    step: (t, f) => drive(f, { speed: 50, throttle: 1, timeScale: t < 1.5 ? 1 : 0.35 }),
    windows: [
      ['timeScale 1', 0.8, 1.4],
      ['timeScale 0.35', 2.6, 2.95],
    ],
    check: (p) => (p['timeScale 0.35'].centroidHz > p['timeScale 1'].centroidHz * 0.85 ? 'centroid did not drop' : null),
  },
  {
    // Every layer except the rocket crackle (intentional impulsive pops would read as "clicks").
    name: 'click-free under rapid state changes',
    solo: null,
    mask: LAYER_NAMES.filter((n) => n !== 'crackle'),
    duration: 4.2,
    step: (t, f) => {
      const k = Math.floor(Math.max(0, t) / 0.3);
      drive(f, {
        speed: 45,
        throttle: k % 2 ? 1 : 0,
        boost: k % 3 === 0 ? 1 : 0,
        slip: k % 4 < 2 ? 0.9 : 0,
        airborne: k % 5 === 4,
        vacMode: k % 3 === 1 ? 'engaged' : k % 3 === 2 ? 'armed' : 'off',
        vacStrength: k % 3 === 1 ? 1 : 0,
        timeScale: k % 7 === 6 ? 0.4 : 1,
        paused: k % 6 === 5,
      });
    },
    windows: [['whole run', 0.2, 4.1]],
    check: (p) => (!audible(p['whole run']) ? 'inaudible' : null),
    clickWindow: [0.2, 4.1],
  },
  {
    name: 'vehicle layers gated outside the game scene',
    solo: null,
    duration: 2,
    scene: 'title',
    step: (_t, f) => drive(f, { speed: 50, throttle: 1, boost: 1 }),
    windows: [['title scene', 0.5, 1.9]],
    check: (p) => (!silent(p['title scene']) ? 'vehicle audible on the title screen' : null),
  },
];

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

const round = (x: number, d = 3): number => {
  const k = Math.pow(10, d);
  return Math.round(x * k) / k;
};

/** Informational row in a layer result. */
const note = (label: string): LayerPoint => ({ label, rmsDb: 0, centroidHz: 0 });

/** A `step` callback that fires each [scenario time, action] once (items sorted by time). */
function timeline(items: Array<[number, (core: SoundCore, f: RenderFrame) => void]>, each?: (t: number, f: RenderFrame) => void): NonNullable<RenderSpec['step']> {
  let i = 0;
  return (t, f, core) => {
    each?.(t, f);
    while (i < items.length && t >= items[i][0] - 1e-9) items[i++][1](core, f);
  };
}

/** Run one behavioural check; exceptions and graph errors fail it. */
async function check(name: string, body: (errors: string[]) => Promise<{ points: LayerPoint[]; fail: string | null; peak?: number }>): Promise<LayerResult> {
  const errors: string[] = [];
  try {
    const r = await body(errors);
    const fail = r.fail ?? (errors.length ? errors.join('; ') : null);
    return { name, points: r.points, peak: round(r.peak ?? 0), pass: !fail, detail: fail ?? 'ok' };
  } catch (e) {
    return { name, points: [], peak: 0, pass: false, detail: [errText(e), ...errors].join('; ') };
  }
}

/** Measure a rendered scenario over scenario-time [from, to) (default: everything after the pre-roll). */
function soundResult(name: string, group: SoundResult['group'], r: Rendered | null, errors: string[], from = 0, to?: number): SoundResult {
  const issues = [...errors];
  if (!r) {
    return { name, group, peak: 0, lufsM: -120, lufsI: -120, lufsT: -120, lufsSmall: -120, rmsDb: -180, activeMs: 0, centroidHz: 0, bands: { sub: 0, low: 0, mid: 0, high: 0, air: 0 }, pass: false, issues };
  }
  const m = analyze(r.buf, r.start + from, to === undefined ? r.buf.duration : r.start + to);
  if (m.peak < SILENT_PEAK) issues.push('silent');
  if (m.peak >= CLIP_LIMIT) issues.push(`clips (peak ${m.peak.toFixed(3)})`);
  return {
    name,
    group,
    peak: round(m.peak),
    lufsM: round(m.lufsM, 1),
    lufsI: round(m.lufsI, 1),
    lufsT: round(m.lufsT, 1),
    lufsSmall: round(m.lufsSmall, 1),
    rmsDb: round(m.rmsDb, 1),
    activeMs: m.activeMs,
    centroidHz: Math.round(m.centroidHz),
    bands: { sub: round(m.bands.sub, 2), low: round(m.bands.low, 2), mid: round(m.bands.mid, 2), high: round(m.bands.high, 2), air: round(m.bands.air, 2) },
    pass: issues.length === 0,
    issues,
  };
}

function point(r: Rendered, label: string, from: number, to: number): LayerPoint {
  const a = r.start + from;
  const b = r.start + to;
  const rmsDb = rmsDbOf(r.buf, a, b);
  const spec = spectrumOf(r.buf, a, b);
  const presence = spec.bands.mid + spec.bands.high;
  return {
    label,
    rmsDb: round(rmsDb, 1),
    centroidHz: Math.round(spec.centroidHz),
    presenceDb: round(presence > 0 ? rmsDb + 10 * Math.log10(presence) : -180, 1),
    lufs: round(loudnessOf(r.buf, a, b).integrated, 1),
  };
}

async function runLayer(c: LayerCase): Promise<LayerResult> {
  const errors: string[] = [];
  try {
    const r = await render({ duration: c.duration, scene: c.scene ?? 'game', solo: c.solo, mask: c.mask, step: c.step }, errors);
    const pts: Record<string, LayerPoint> = {};
    const points: LayerPoint[] = [];
    for (const [label, from, to] of c.windows) {
      const pt = point(r, label, from, to);
      pts[label] = pt;
      points.push(pt);
    }
    const peak = peakOf(r.buf);
    let fail = c.check(pts);
    if (!fail && c.clickWindow) {
      const cl = clicksOf(r.buf, r.start + c.clickWindow[0], r.start + c.clickWindow[1]);
      points.push({ label: `clicks ${cl.count} (worst spike ${cl.worstDb.toFixed(1)} dB)`, rmsDb: 0, centroidHz: 0 });
      if (cl.count > 0) fail = `${cl.count} click(s), worst HF spike ${cl.worstDb.toFixed(1)} dB over local median`;
    }
    if (!fail && peak >= CLIP_LIMIT) fail = `clips (peak ${peak.toFixed(3)})`;
    if (!fail && errors.length) fail = errors.join('; ');
    return { name: c.name, points, peak: round(peak), pass: !fail, detail: fail ?? 'ok' };
  } catch (e) {
    return { name: c.name, points: [], peak: 0, pass: false, detail: [errText(e), ...errors].join('; ') };
  }
}

async function runMusic(): Promise<{ sounds: SoundResult[]; layers: LayerResult[] }> {
  const sounds: SoundResult[] = [];
  const layers: LayerResult[] = [];
  // Music-only measurements: soloing an idle layer ('scrape' without impacts) mutes the vehicle bus.
  const cruise: DriveSpec = { speed: 25, throttle: 0.5 };
  const flight: DriveSpec = { speed: 60, airborne: true, boost: 1, angVel: 2 };

  const cases: Array<{ name: string; spec: RenderSpec; from: number }> = [
    { name: 'music: title', spec: { duration: 14, scene: 'title', music: true }, from: 2 },
    { name: 'music: game cruise', spec: { duration: 12, scene: 'game', music: true, solo: 'scrape', step: (_t, f) => drive(f, cruise) }, from: 4 },
    { name: 'music: game flight + boost', spec: { duration: 12, scene: 'game', music: true, solo: 'scrape', step: (_t, f) => drive(f, flight) }, from: 4 },
    { name: 'music: complete', spec: { duration: 12, scene: 'complete', music: true }, from: 2 },
    // Ambience alone: score stopped right after the pre-roll, sky bed keeps going.
    { name: 'sky ambience (title, score stopped)', spec: { duration: 8, scene: 'title', music: true, setup: (core) => core.music?.stop(core.ctx.currentTime, 0.2) }, from: 2 },
  ];
  const rendered: Record<string, Rendered | null> = {};
  for (const c of cases) {
    const errors: string[] = [];
    let r: Rendered | null = null;
    try {
      r = await render(c.spec, errors);
    } catch (e) {
      errors.push(errText(e));
    }
    rendered[c.name] = r;
    sounds.push(soundResult(c.name, 'music', r, errors, c.from));
  }

  // Intensity: flight must be louder or clearly denser in the presence band (arp / hats / lift layer).
  const rc = rendered['music: game cruise'];
  const rf = rendered['music: game flight + boost'];
  if (rc && rf) {
    const lo = point(rc, 'cruise', 4, 12);
    const hi = point(rf, 'flight + boost', 4, 12);
    const ok = hi.rmsDb > lo.rmsDb + 1.5 || (hi.presenceDb ?? -180) > (lo.presenceDb ?? -180) + 3;
    layers.push({
      name: 'music intensity layers',
      points: [lo, hi],
      peak: round(Math.max(peakOf(rc.buf), peakOf(rf.buf))),
      pass: ok,
      detail: ok ? 'ok' : 'flight not denser/louder than cruise',
    });
  }

  // Arrangement crossfades (title → complete → title): sustained voices must hand over click-free.
  {
    const errors: string[] = [];
    try {
      let stage = 0;
      const r = await render(
        {
          duration: 12,
          scene: 'title',
          music: true,
          step: (t, _f, core) => {
            if (t >= 4 && stage === 0) {
              stage = 1;
              core.setScene('complete');
            } else if (t >= 8 && stage === 1) {
              stage = 2;
              core.setScene('title');
            }
          },
        },
        errors,
      );
      const cl = clicksOf(r.buf, r.start + 0.5, r.start + 12);
      const ok = cl.count === 0 && errors.length === 0;
      layers.push({
        name: 'music arrangement crossfades click-free',
        points: [point(r, 'title', 1, 4), point(r, 'complete', 5, 8), point(r, 'title again', 9, 12), { label: `clicks ${cl.count} (worst ${cl.worstDb.toFixed(1)} dB)`, rmsDb: 0, centroidHz: 0 }],
        peak: round(peakOf(r.buf)),
        pass: ok,
        detail: ok ? 'ok' : errors.join('; ') || `${cl.count} click(s), worst ${cl.worstDb.toFixed(1)} dB`,
      });
    } catch (e) {
      layers.push({ name: 'music arrangement crossfades click-free', points: [], peak: 0, pass: false, detail: errText(e) });
    }
  }

  // Pause ducking: game music, paused at 4 s (frames stop advancing), resumed at 8 s.
  {
    const name = 'music ducks + darkens on pause, recovers on resume';
    const errors: string[] = [];
    try {
      let stage = 0;
      const r = await render(
        {
          duration: 11.5,
          scene: 'game',
          music: true,
          solo: 'scrape',
          step: (t, f, core) => {
            drive(f, { ...cruise, paused: stage === 1 });
            if (t >= 4 && stage === 0) {
              stage = 1;
              core.setScene('paused');
            } else if (t >= 8 && stage === 1) {
              stage = 2;
              core.setScene('game');
            }
          },
        },
        errors,
      );
      const a = point(r, 'game', 2, 4);
      const b = point(r, 'paused', 5, 8);
      const c = point(r, 'resumed', 9.5, 11.5);
      const ducked = b.rmsDb < a.rmsDb - 3 && b.centroidHz < a.centroidHz;
      const recovered = Math.abs(c.rmsDb - a.rmsDb) < 2;
      const ok = ducked && recovered && errors.length === 0;
      layers.push({
        name,
        points: [a, b, c],
        peak: round(peakOf(r.buf)),
        pass: ok,
        detail: ok ? 'ok' : errors.join('; ') || (!ducked ? 'no duck' : 'level did not recover after resume'),
      });
    } catch (e) {
      layers.push({ name, points: [], peak: 0, pass: false, detail: errText(e) });
    }
  }

  // Menus never inherit a stale slow-mo: the runner keeps runtime.frame pointing at the last snapshot
  // (timeScale 0.35 if the player quit during a crash or tutorial bullet time).
  {
    const name = 'stale slow-mo timeScale never muffles the menus';
    const errors: string[] = [];
    try {
      let flag = true;
      const r = await render(
        {
          duration: 6,
          scene: 'title',
          music: true,
          step: (_t, f) => drive(f, { timeScale: 0.35, paused: true }),
          after: (core) => {
            flag = core.debug.slowmo;
          },
        },
        errors,
      );
      const ref = rendered['music: title'];
      const a = point(r, 'title, stale timeScale 0.35', 2, 6);
      const b = ref ? point(ref, 'title reference', 2, 6) : null;
      const ok = !flag && !!b && Math.abs(a.rmsDb - b.rmsDb) < 0.3 && Math.abs(a.centroidHz - b.centroidHz) < 15 && errors.length === 0;
      layers.push({
        name,
        points: b ? [a, b, note(`slow-mo flag ${flag}`)] : [a],
        peak: round(peakOf(r.buf)),
        pass: ok,
        detail: ok ? 'ok' : errors.join('; ') || (flag ? 'slow-mo engaged on the title scene' : 'title score altered'),
      });
    } catch (e) {
      layers.push({ name, points: [], peak: 0, pass: false, detail: errText(e) });
    }
  }

  // Landing resolution: airborne (suspended harmony) then a clean landing re-syncs the grid.
  {
    const errors: string[] = [];
    let r: Rendered | null = null;
    try {
      let landed = false;
      r = await render(
        {
          duration: 8,
          scene: 'game',
          music: true,
          solo: 'scrape',
          step: (t, f, core) => {
            drive(f, t < 4.3 ? flight : cruise);
            if (t >= 4.3 && !landed) {
              landed = true;
              core.handleEvent({ type: 'landing', result: landing('clean', 9) });
            }
          },
        },
        errors,
      );
    } catch (e) {
      errors.push(errText(e));
    }
    sounds.push(soundResult('music: flight → landing resolve', 'music', r, errors, 3));
  }
  return { sounds, layers };
}

/* ------------------------------------------------------------------ */
/* Behaviour: the real sim's event semantics, scenes and transitions   */
/* ------------------------------------------------------------------ */

const IMPACT = (strength: number): GameEvent => ({ type: 'impact', position: P0, normal: UP, strength });
const SLAM = (strength: number): GameEvent => ({ type: 'wheelSlam', position: P0, strength });
const trickOf = (kind: 'backflip' | 'spin' | 'hangTime', count: number): GameEvent => ({ type: 'trick', trick: { kind, label: kind.toUpperCase(), count, points: 500 } });
/** No audible vehicle layer (one-shots only). */
const NO_LAYERS: readonly LayerName[] = [];

async function runBehaviour(onProgress?: (label: string) => void): Promise<LayerResult[]> {
  const out: LayerResult[] = [];
  const add = async (name: string, body: Parameters<typeof check>[1]): Promise<void> => {
    onProgress?.(name);
    out.push(await check(name, body));
  };

  await add('intentionally silent events stay silent (objective, zoneEnter, info/success/null prompt)', async (errors) => {
    const r = await render(
      {
        duration: 1,
        setup: (core) => {
          core.handleEvent({ type: 'objective', index: 1, id: 'o2', title: 'NEXT' });
          core.handleEvent({ type: 'zoneEnter', id: 'z' });
          core.handleEvent({ type: 'prompt', prompt: null });
          core.handleEvent({ type: 'prompt', prompt: { id: 'p', text: 'INFO', hint: null, tone: 'info' } });
          core.handleEvent({ type: 'prompt', prompt: { id: 'q', text: 'NICE', hint: null, tone: 'success' } });
        },
      },
      errors,
    );
    const pk = peakOf(r.buf);
    return { points: [note(`peak ${pk.toExponential(1)}`)], fail: pk >= SILENT_PEAK ? `audible (peak ${pk.toFixed(4)})` : null, peak: pk };
  });

  await add('gameplay events are ignored on the title scene', async (errors) => {
    const r = await render(
      {
        duration: 1.5,
        scene: 'title',
        setup: (core) => {
          core.handleEvent({ type: 'crash', reason: 'impact', position: P0, impactSpeed: 25 });
          core.handleEvent({ type: 'landing', result: landing('hard', 20) });
          core.handleEvent({ type: 'boostStart' });
          core.handleEvent(SLAM(1));
          core.handleEvent(trick(1));
        },
      },
      errors,
    );
    const pk = peakOf(r.buf);
    return { points: [note(`peak ${pk.toExponential(1)}`)], fail: pk >= SILENT_PEAK ? `audible on the title scene (peak ${pk.toFixed(4)})` : null, peak: pk };
  });

  // The sim reports `landing` 0.15 s after the touchdown whose wheel slams already sounded.
  await add('landing after its touchdown slam (sim order): no second full thud, verdict intact', async (errors) => {
    const points: LayerPoint[] = [];
    const fails: string[] = [];
    let peak = 0;
    for (const [q, imp, minDrop] of [
      ['clean', 11, 4],
      ['hard', 20, 2.5],
    ] as const) {
      const each = (_t: number, f: RenderFrame): void => drive(f, { speed: 30 });
      const withSlam = await render(
        { duration: 1.2, mask: NO_LAYERS, step: timeline([[0, (c) => c.handleEvent(SLAM(0.6))], [0.15, (c) => c.handleEvent({ type: 'landing', result: landing(q, imp) })]], each) },
        errors,
      );
      const alone = await render({ duration: 1.2, mask: NO_LAYERS, step: timeline([[0.15, (c) => c.handleEvent({ type: 'landing', result: landing(q, imp) })]], each) }, errors);
      // The landing fires on the first update frame at/after 0.15 s.
      const a = withSlam.start + 0.15;
      const lowWith = lowBandDbOf(withSlam.buf, a, a + 0.3);
      const lowAlone = lowBandDbOf(alone.buf, a, a + 0.3);
      const verdict = rmsDbOf(withSlam.buf, a, a + 0.3);
      peak = Math.max(peak, peakOf(withSlam.buf), peakOf(alone.buf));
      points.push(note(`${q}: thud band ${lowWith.toFixed(1)} dB after a slam vs ${lowAlone.toFixed(1)} alone · verdict rms ${verdict.toFixed(1)} dB`));
      if (lowWith > lowAlone - minDrop) fails.push(`${q}: second thud only ${(lowAlone - lowWith).toFixed(1)} dB lighter`);
      if (verdict < -45) fails.push(`${q}: verdict inaudible`);
    }
    return { points, fail: fails.length ? fails.join('; ') : null, peak };
  });

  await add('slow-mo: bullet time gets its sting, the PERFECT reward slow-mo does not', async (errors) => {
    const perfect = (ts: number): NonNullable<RenderSpec['step']> =>
      timeline([[0, (c) => c.handleEvent({ type: 'landing', result: landing('perfect', 5) })]], (t, f) => drive(f, { speed: 30, timeScale: t >= 0.03 && t < 0.75 ? ts : 1 }));
    const a = await render({ duration: 2.5, mask: NO_LAYERS, step: perfect(0.5) }, errors);
    const b = await render({ duration: 2.5, mask: NO_LAYERS, step: perfect(1) }, errors);
    const bullet = await render({ duration: 2, mask: NO_LAYERS, step: (t, f) => drive(f, { speed: 30, timeScale: t >= 0.3 && t < 1.6 ? 0.3 : 1 }) }, errors);
    const la = loudnessOf(a.buf, a.start, a.start + 2.5).momentaryMax;
    const lb = loudnessOf(b.buf, b.start, b.start + 2.5).momentaryMax;
    const sting = rmsDbOf(bullet.buf, bullet.start + 0.3, bullet.start + 1.3);
    const fails: string[] = [];
    if (Math.abs(la - lb) > 0.5) fails.push(`PERFECT slow-mo changed the landing by ${(la - lb).toFixed(1)} LU`);
    if (sting < -45) fails.push('bullet time sting inaudible');
    return {
      points: [note(`PERFECT ${la.toFixed(1)} LUFS-M with reward slow-mo vs ${lb.toFixed(1)} without`), note(`bullet-time sting rms ${sting.toFixed(1)} dB`)],
      fail: fails.length ? fails.join('; ') : null,
      peak: Math.max(peakOf(a.buf), peakOf(bullet.buf)),
    };
  });

  // TrickTracker: one event per completed rotation (count rises), plus bonuses with count 1.
  await add('trick dings climb the ladder with the sim event pattern (flip, DOUBLE flip, spin, bonus)', async (errors) => {
    const times = [0, 0.5, 1, 1.5];
    const evs = [trickOf('backflip', 1), trickOf('backflip', 2), trickOf('spin', 1), trickOf('hangTime', 1)];
    const r = await render(
      { duration: 2.3, mask: NO_LAYERS, step: timeline(times.map((t0, i): [number, (c: SoundCore) => void] => [t0, (c) => c.handleEvent(evs[i])]), (_t, f) => drive(f, { speed: 40, airborne: true })) },
      errors,
    );
    const hz = times.map((t0) => Math.round(dominantHzOf(r.buf, r.start + t0 + 0.04, r.start + t0 + 0.32, 600, 2600)));
    const rising = hz.every((f, i) => i === 0 || f > hz[i - 1] * 1.03);
    return { points: [note(`ding pitches ${hz.join(' → ')} Hz`)], fail: rising ? null : `not strictly rising: ${hz.join(', ')}`, peak: peakOf(r.buf) };
  });

  // CrashDetector: an impact on contact, then a report every 0.1 s (sim time) while sliding.
  await add('sustained scrape stays continuous (no clank stream), also in slow motion', async (errors) => {
    const fails: string[] = [];
    const points: LayerPoint[] = [];
    let peak = 0;
    for (const ts of [1, 0.35]) {
      let simT = 0;
      let next = 0.3;
      let first = true;
      let voices = -1;
      const until = 0.3 + 1.8;
      const dur = ts === 1 ? 2.6 : 3.6;
      // Real time well past the onset clank (the scrape starts at 0.3 s of sim time).
      const sampleAt = ts === 1 ? 1.5 : 2.6;
      const r = await render(
        {
          duration: dur,
          mask: ['scrape'],
          step: (t, f, core) => {
            drive(f, { speed: 20, timeScale: ts });
            if (t < 0) return;
            simT += FRAME * ts;
            if (simT >= next && simT < until) {
              core.handleEvent(IMPACT(first ? 0.6 : 0.3));
              first = false;
              next += 0.1;
            }
            if (voices < 0 && t >= sampleAt) voices = core.debug.sfxVoices;
          },
        },
        errors,
      );
      // Real-time window well inside the scrape (past the onset clank and, in slow motion, the bullet-time sting).
      const from = ts === 1 ? 0.8 : 1.6;
      const to = ts === 1 ? 2.0 : 3.4;
      const env = envelopeSpreadOf(r.buf, r.start + from, r.start + to);
      const rms = rmsDbOf(r.buf, r.start + from, r.start + to);
      peak = Math.max(peak, peakOf(r.buf));
      points.push(note(`timeScale ${ts}: envelope p10 ${env.p10.toFixed(1)} / p90 ${env.p90.toFixed(1)} dB (spread ${env.spread.toFixed(1)}), rms ${rms.toFixed(1)}, one-shots alive mid-scrape ${voices}`));
      if (env.spread > 8) fails.push(`timeScale ${ts}: envelope spread ${env.spread.toFixed(1)} dB`);
      if (rms < -48) fails.push(`timeScale ${ts}: scrape inaudible`);
      if (voices < 0 || voices > 1) fails.push(`timeScale ${ts}: ${voices} clank voices alive mid-scrape`);
    }
    return { points, fail: fails.length ? fails.join('; ') : null, peak };
  });

  await add('restart during the level-complete fanfare: fanfare fades, gameplay score resumes', async (errors) => {
    const lc: GameEvent = { type: 'levelComplete', result: levelResult() };
    const withReset = await render({ duration: 3.6, mask: NO_LAYERS, step: timeline([[0, (c) => c.handleEvent(lc)], [1, (c) => c.handleEvent({ type: 'reset' })]], (_t, f) => drive(f, {})) }, errors);
    const noReset = await render({ duration: 3.6, mask: NO_LAYERS, step: timeline([[0, (c) => c.handleEvent(lc)]], (_t, f) => drive(f, {})) }, errors);
    const faded = rmsDbOf(withReset.buf, withReset.start + 1.75, withReset.start + 3.4);
    const ringing = rmsDbOf(noReset.buf, noReset.start + 1.75, noReset.start + 3.4);
    const musicVoices = async (reset: boolean): Promise<number> => {
      let n = -1;
      const items: Array<[number, (c: SoundCore) => void]> = [[0, (c) => c.handleEvent(lc)]];
      if (reset) items.push([1, (c) => c.handleEvent({ type: 'reset' })]);
      items.push([2.4, (c) => (n = c.debug.music?.voices ?? 0)]);
      await render({ duration: 2.6, music: true, mask: NO_LAYERS, step: timeline(items, (_t, f) => drive(f, { speed: 20 })) }, errors);
      return n;
    };
    const resumed = await musicVoices(true);
    const held = await musicVoices(false);
    const fails: string[] = [];
    if (faded > ringing - 15) fails.push(`fanfare only ${(ringing - faded).toFixed(1)} dB down after restart`);
    if (resumed <= 0) fails.push('score did not resume after restart');
    if (held !== 0) fails.push(`score not held during the fanfare (${held} voices)`);
    return {
      points: [note(`fanfare tail ${faded.toFixed(1)} dB after restart vs ${ringing.toFixed(1)} dB`), note(`music voices 1.4 s after restart ${resumed} (held without restart: ${held})`)],
      fail: fails.length ? fails.join('; ') : null,
      peak: peakOf(withReset.buf),
    };
  });

  // Objectives.ts completes an objective and raises the next prompt (or the level) in the same tick.
  await add('same-tick cues: one sound per moment (objective tick vs fanfare, prompt notify vs tick)', async (errors) => {
    let tickOnly = -1;
    let withLevel = -1;
    let withPrompt = -1;
    await render(
      {
        duration: 0.5,
        setup: (core) => {
          core.handleEvent({ type: 'objectiveComplete', index: 2, id: 'land' });
          tickOnly = core.debug.sfxVoices;
          core.handleEvent({ type: 'levelComplete', result: levelResult() });
          withLevel = core.debug.sfxVoices;
        },
      },
      errors,
    );
    await render(
      {
        duration: 0.5,
        setup: (core) => {
          core.handleEvent({ type: 'objectiveComplete', index: 1, id: 'jump' });
          core.handleEvent({ type: 'objective', index: 2, id: 'stab', title: 'STABILIZE' });
          core.handleEvent({ type: 'prompt', prompt: { id: 'p', text: 'HOLD SHIFT', hint: null, tone: 'action' } });
          withPrompt = core.debug.sfxVoices;
        },
      },
      errors,
    );
    const ok = tickOnly === 1 && withLevel === 1 && withPrompt === 1;
    return {
      points: [note(`one-shot voices: objective tick ${tickOnly} · + levelComplete ${withLevel} (fanfare only) · tick + next prompt ${withPrompt}`)],
      fail: ok ? null : 'same-tick cues stacked',
    };
  });

  await add('toggle / flicker events are debounced (vacuum on/off/engage/release, boost end)', async (errors) => {
    let alive = -1;
    const r = await render(
      {
        duration: 1.2,
        mask: NO_LAYERS,
        step: (t, f, core) => {
          drive(f, { speed: 20 });
          if (t >= 0 && t < 0.6) {
            for (const e of [{ type: 'vacuumOn' }, { type: 'vacuumEngaged', position: P0, normal: UP }, { type: 'vacuumReleased', position: P0 }, { type: 'vacuumOff' }, { type: 'boostStart' }, { type: 'boostEnd' }] as GameEvent[]) {
              core.handleEvent(e);
            }
          } else if (t >= 0.6 && alive < 0) {
            alive = core.debug.sfxVoices;
          }
        },
      },
      errors,
    );
    const pk = peakOf(r.buf);
    const fails: string[] = [];
    if (alive > 6) fails.push(`${alive} voices from 19 frames of toggling`);
    if (pk >= CLIP_LIMIT) fails.push(`clips (peak ${pk.toFixed(3)})`);
    return { points: [note(`6 event kinds every frame for 0.6 s → ${alive} one-shot voices alive`)], fail: fails.length ? fails.join('; ') : null, peak: pk };
  });

  // Bus routing: every source must sit behind exactly the bus its slider controls.
  await add('mix buses: score + ambience on music, vehicle + one-shots + UI on sfx, master / mute silence all', async (errors) => {
    const busy = (core: SoundCore): void => {
      core.handleEvent({ type: 'boostStart' });
      core.handleEvent({ type: 'landing', result: landing('perfect', 5) });
      core.handleEvent(trick(2));
      core.ui('click');
      core.ui('start');
    };
    const driveAll = (_t: number, f: RenderFrame): void => drive(f, { speed: 45, throttle: 1, boost: 1, slip: 0.6, vacMode: 'engaged', vacStrength: 1 });
    const cases: Array<[label: string, spec: RenderSpec]> = [
      ['score + ambience with music 0', { duration: 4, scene: 'title', music: true, mix: { master: 1, music: 0, sfx: 1, muted: false } }],
      ['vehicle + one-shots + UI with sfx 0', { duration: 3, music: false, mix: { master: 1, music: 1, sfx: 0, muted: false }, setup: busy, step: driveAll }],
      ['everything with master 0', { duration: 3, music: true, mix: { master: 0, music: 1, sfx: 1, muted: false }, setup: busy, step: driveAll }],
      ['everything muted', { duration: 3, music: true, mix: { master: 1, music: 1, sfx: 1, muted: true }, setup: busy, step: driveAll }],
    ];
    const points: LayerPoint[] = [];
    const fails: string[] = [];
    for (const [label, spec] of cases) {
      const r = await render(spec, errors);
      const pk = peakOf(r.buf);
      points.push(note(`${label}: peak ${pk.toExponential(1)}`));
      if (pk >= SILENT_PEAK) fails.push(`${label} leaks (peak ${pk.toFixed(4)})`);
    }
    return { points, fail: fails.length ? fails.join('; ') : null };
  });

  await add('vehicle layers fade (not cut) when the scene leaves gameplay (game → complete)', async (errors) => {
    let switched = false;
    const r = await render(
      {
        duration: 5,
        step: (t, f, core) => {
          drive(f, { speed: 50, throttle: 1, boost: 0.5 });
          if (t >= 1 && !switched) {
            switched = true;
            core.setScene('complete');
          }
        },
      },
      errors,
    );
    const playing = rmsDbOf(r.buf, r.start + 0.5, r.start + 0.95);
    const fading = rmsDbOf(r.buf, r.start + 1.1, r.start + 1.4);
    const after = rmsDbOf(r.buf, r.start + 4.4, r.start + 4.95);
    const fails: string[] = [];
    if (fading < playing - 10) fails.push('cut instead of fade');
    if (after > SILENT_DB) fails.push(`still audible after the fade (${after.toFixed(1)} dB)`);
    return { points: [note(`rms playing ${playing.toFixed(1)} → fading ${fading.toFixed(1)} → after ${after.toFixed(1)} dB`)], fail: fails.length ? fails.join('; ') : null, peak: peakOf(r.buf) };
  });

  return out;
}

/** Voice stealing: when a pool is full, sustained / critical voices must never be cut. */
function runStealing(): LayerResult {
  const name = 'voice stealing never cuts sustained voices';
  try {
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 128, sampleRate: SR });
    const pool = new VoicePool(ctx, 3);
    const sustain = pool.acquire(0, 2);
    sustain?.osc('sine', 220, 0, Infinity).connect(ctx.destination);
    const normals: Array<ReturnType<VoicePool['acquire']>> = [];
    for (let i = 0; i < 6; i++) {
      const v = pool.acquire(0.01 * i, 1);
      v?.osc('sine', 440, 0.01 * i, 0.5).connect(ctx.destination);
      normals.push(v);
    }
    const expendable = pool.acquire(0.1, 0);
    const alive = !!sustain && !sustain.isFinished;
    const size = pool.size;
    const ok = alive && size === 3 && expendable === null && normals.every((v) => v !== null);
    pool.cancelAll();
    return {
      name,
      points: [{ label: `6 normal requests into a full pool: sustained alive ${alive}, pool ${size}/3, expendable refused ${expendable === null}`, rmsDb: 0, centroidHz: 0 }],
      peak: 0,
      pass: ok,
      detail: ok ? 'ok' : 'stealing policy violated',
    };
  } catch (e) {
    return { name, points: [], peak: 0, pass: false, detail: errText(e) };
  }
}

/** Corrupt sim values (NaN / Infinity) must neither throw nor put non-finite samples in the output. */
async function runRobustness(): Promise<LayerResult> {
  const errors: string[] = [];
  try {
    let n = 0;
    const r = await render(
      {
        duration: 2.5,
        scene: 'game',
        music: true,
        step: (t, f, core) => {
          drive(f, { speed: 40, throttle: 1, boost: 0.5, slip: 0.5, vacMode: 'engaged', vacStrength: 0.5 });
          const v = f.snapshot.vehicle;
          if (t > 0.5 && t < 1.5) {
            v.speed = NaN;
            v.boostLevel = Infinity;
            v.throttle = NaN;
            v.wheels[0].spinRate = NaN;
            v.wheels[1].slip = -Infinity;
            v.angularVelocity.set(NaN, 0, 0);
            v.rcs.roll = NaN;
            v.vacuum.strength = NaN;
            f.snapshot.timeScale = NaN;
            f.dt = NaN;
            f.simDt = Infinity;
            if (n++ % 4 === 0) {
              core.handleEvent({ type: 'impact', position: P0, normal: UP, strength: NaN });
              core.handleEvent({ type: 'wheelSlam', position: P0, strength: Infinity });
              core.handleEvent({ type: 'takeoff', position: P0, speed: NaN });
              core.handleEvent({ type: 'crash', reason: 'impact', position: P0, impactSpeed: NaN });
              core.handleEvent({ type: 'landing', result: { ...landing('hard', NaN) } });
              core.handleEvent({ type: 'trick', trick: { kind: 'spin', label: 'SPIN', count: NaN, points: 0 } });
            }
          }
        },
      },
      errors,
    );
    let finite = true;
    for (let c = 0; c < r.buf.numberOfChannels && finite; c++) {
      const d = r.buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        if (!Number.isFinite(d[i])) {
          finite = false;
          break;
        }
      }
    }
    const after = point(r, 'recovered after corruption', 1.8, 2.4);
    const ok = errors.length === 0 && finite && audible(after);
    return {
      name: 'robust to NaN / Infinity sim values',
      points: [after],
      peak: round(peakOf(r.buf)),
      pass: ok,
      detail: ok ? 'ok' : [!finite ? 'non-finite samples' : '', !audible(after) ? 'did not recover' : '', ...errors].filter(Boolean).join('; '),
    };
  } catch (e) {
    return { name: 'robust to NaN / Infinity sim values', points: [], peak: 0, pass: false, detail: [errText(e), ...errors].join('; ') };
  }
}

async function runMixStress(): Promise<SoundResult> {
  const errors: string[] = [];
  let r: Rendered | null = null;
  try {
    let fired = false;
    r = await render(
      {
        duration: 7,
        scene: 'game',
        music: true,
        step: (t, f, core) => {
          drive(f, { speed: 75, throttle: 1, boost: 1, slip: 1, vacMode: 'engaged', vacStrength: 1, rcs: 1, angVel: 5 });
          core.vehicle.addImpact(1);
          if (t >= 2 && !fired) {
            fired = true;
            const evs: GameEvent[] = [
              { type: 'crash', reason: 'impact', position: P0, impactSpeed: 30 },
              { type: 'landing', result: landing('perfect', 5) },
              { type: 'levelComplete', result: levelResult() },
              { type: 'boostStart' },
              { type: 'impact', position: P0, normal: UP, strength: 1 },
              { type: 'wheelSlam', position: P0, strength: 1 },
              { type: 'vacuumEngaged', position: P0, normal: UP },
              trick(6),
            ];
            for (const e of evs) core.handleEvent(e);
            core.ui('start');
          }
        },
      },
      errors,
    );
  } catch (e) {
    errors.push(errText(e));
  }
  return soundResult('WORST CASE: everything maxed @ full volume', 'mix', r, errors);
}

/** 14 s of the scripted MockSim (accelerate, boost, jump + backflip, landing, vacuum, drift, crash, reset). */
async function runMockSim(): Promise<{ sound: SoundResult; drain: LayerResult }> {
  const errors: string[] = [];
  let r: Rendered | null = null;
  let pools = { sfx: -1, ui: -1, music: -1 };
  try {
    const sim = new MockSim();
    r = await render(
      {
        duration: 14,
        scene: 'game',
        music: true,
        mix: DEFAULT_MIX,
        step: (t, f, core) => {
          if (t < 0) return; // sim starts after the pre-roll
          const events = sim.update(FRAME);
          const snap = sim.snapshot;
          f.snapshot = snap;
          f.position.copy(snap.vehicle.position);
          f.quaternion.copy(snap.vehicle.quaternion);
          for (const e of events) core.handleEvent(e);
        },
        after: (core) => {
          const d = core.debug;
          pools = { sfx: d.sfxVoices, ui: d.uiVoices, music: d.music?.voices ?? 0 };
        },
      },
      errors,
    );
  } catch (e) {
    errors.push(errText(e));
  }
  // The script's last one-shots end well before the render does; only sustained pads and notes
  // queued in the scheduler lookahead may legitimately still be alive.
  const drained = pools.sfx >= 0 && pools.sfx <= 3 && pools.ui === 0 && pools.music <= 12;
  return {
    sound: soundResult('MockSim 14 s run (default mix)', 'mix', r, errors),
    drain: {
      name: 'voices self-clean (pools drain after MockSim run)',
      points: [{ label: `alive at end: sfx ${pools.sfx}, ui ${pools.ui}, music ${pools.music}`, rmsDb: 0, centroidHz: 0 }],
      peak: 0,
      pass: drained,
      detail: drained ? 'ok' : 'voices leaked',
    },
  };
}

/**
 * CPU cost: a heavy 10 s scene (every vehicle layer active, score at full intensity, a one-shot every
 * second), all scheduled up front, rendered offline without per-frame callbacks. The real-time factor
 * approximates the audio-thread budget the graph needs (offline is pessimistic: Chrome renders the
 * convolver tail on a background thread in real time). Best of 3 — wall-clock timing on a shared
 * machine is noisy; the bound only guards against pathological regressions.
 */
async function runCpu(): Promise<LayerResult> {
  const name = 'CPU: heavy scene renders faster than real time';
  try {
    let best = 0;
    for (let i = 0; i < 3; i++) best = Math.max(best, await cpuFactor());
    const load = 100 / best;
    const ok = best > 5;
    return {
      name,
      points: [{ label: `${best.toFixed(1)}× real time ≈ ${load.toFixed(1)} % of one core (best of 3)`, rmsDb: 0, centroidHz: 0 }],
      peak: 0,
      pass: ok,
      detail: ok ? 'ok' : `only ${best.toFixed(1)}× real time`,
    };
  } catch (e) {
    return { name, points: [], peak: 0, pass: false, detail: errText(e) };
  }
}

async function cpuFactor(): Promise<number> {
  const dur = 10;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: dur * SR, sampleRate: SR });
  const core = new SoundCore(ctx, { mix: FULL_MIX, scene: 'game', music: true });
  core.output.connect(ctx.destination);
  const frame = makeFrame();
  drive(frame, { speed: 60, throttle: 1, boost: 1, slip: 0.6, vacMode: 'engaged', vacStrength: 1, rcs: 0.8, angVel: 4 });
  core.update(frame);
  core.vehicle.addImpact(0.8);
  core.music?.setDrive(1, 1, 0);
  for (let t = 0; t < dur; t += 0.2) core.music?.schedule(t);
  for (let i = 1; i < dur; i++) {
    const at = i + 0.01;
    if (i % 3 === 0) core.sfx.crash(at, 24, 1);
    else if (i % 3 === 1) core.sfx.landing(at, 'perfect', 5, 1);
    else core.sfx.boostIgnition(at, 1);
  }
  const t0 = performance.now();
  await withTimeout(ctx.startRendering(), 30000, 'cpu render');
  const ms = performance.now() - t0;
  core.dispose();
  return (dur * 1000) / Math.max(1, ms);
}

async function runLive(analyser?: AnalyserNode | null): Promise<LiveResult> {
  const errors: string[] = [];
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  try {
    await withTimeout(audio.unlock(), 3000, 'unlock');
    const an = analyser ?? audio.createAnalyser(2048);
    const prevScene = audio.debug?.scene ?? 'title';
    audio.setScene('game');
    const frame = makeFrame();
    drive(frame, { speed: 40, throttle: 1, boost: 0.6 });
    // Every public trigger through the singleton API.
    for (const c of ONE_SHOTS) {
      try {
        firePublic(c, audio);
      } catch (e) {
        errors.push(`${c.name}: ${errText(e)}`);
      }
    }
    let peak = 0;
    if (an) {
      const data = new Float32Array(an.fftSize);
      const t0 = performance.now();
      while (performance.now() - t0 < 800) {
        audio.update(frame);
        an.getFloatTimeDomainData(data);
        for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
        await sleep(25);
      }
    }
    audio.setScene(prevScene);

    // Tab hidden → context suspended; visible again → resumed.
    const setHidden = (hidden: boolean): void => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    let hiddenState = '?';
    let visibleState = '?';
    try {
      setHidden(true);
      await sleep(200);
      hiddenState = audio.state;
      setHidden(false);
      await sleep(200);
      visibleState = audio.state;
    } finally {
      Reflect.deleteProperty(document, 'hidden'); // restore the prototype getter
      document.dispatchEvent(new Event('visibilitychange'));
    }
    if (hiddenState !== 'suspended') errors.push(`hidden tab left the context ${hiddenState}`);
    if (visibleState !== 'running') errors.push(`visible tab left the context ${visibleState}`);

    // Mute suspends the context after the fade; unmute resumes it.
    const mixBefore = { ...DEFAULT_MIX };
    let mute = '';
    {
      audio.setMix({ ...mixBefore, muted: true });
      await sleep(500);
      const sMuted = audio.state;
      audio.setMix({ ...mixBefore, muted: false });
      await sleep(200);
      const sUnmuted = audio.state;
      mute = `muted → ${sMuted}, unmuted → ${sUnmuted}`;
      if (sMuted !== 'suspended' || sUnmuted !== 'running') errors.push(`mute: ${mute}`);
    }

    // Lifecycle on a separate engine: locked no-ops → unlock → use → dispose → unlock again.
    let lifecycle = '';
    const e2 = new AudioEngine();
    try {
      // Before unlock every call is a cheap no-op (mix / scene are remembered).
      e2.setMix({ master: 0.5, music: 0.5, sfx: 0.5, muted: false });
      e2.setScene('game');
      e2.update(frame);
      e2.handleEvent({ type: 'crash', reason: 'impact', position: P0, impactSpeed: 20 });
      e2.ui('click');
      const lockedOk = e2.state === 'locked' && !e2.unlocked && e2.createAnalyser() === null && e2.debug === null && e2.currentTime === 0;
      if (!lockedOk) errors.push('engine misbehaves before unlock');
      await withTimeout(e2.unlock(), 3000, 'engine 2 unlock');
      if (e2.debug?.scene !== 'game') errors.push(`scene set before unlock not applied (${e2.debug?.scene})`);
      const s1 = e2.state;
      e2.setScene('game');
      e2.update(frame);
      e2.handleEvent({ type: 'boostStart' });
      e2.dispose();
      const s2 = e2.state;
      await withTimeout(e2.unlock(), 3000, 'engine 2 re-unlock');
      const s3 = e2.state;
      lifecycle = `${s1} → dispose → ${s2} → unlock → ${s3}`;
      if (s1 !== 'running' || s2 !== 'locked' || s3 !== 'running') errors.push(`lifecycle: ${lifecycle}`);
    } finally {
      e2.dispose();
    }
    return { state: audio.state, contextTime: round(audio.currentTime, 2), analyserPeak: round(peak), hiddenState, visibleState, lifecycle, mute, errors };
  } catch (e) {
    errors.push(errText(e));
    return { state: audio.state, contextTime: round(audio.currentTime, 2), analyserPeak: 0, hiddenState: '?', visibleState: '?', lifecycle: '', mute: '', errors };
  }
}

export interface SelfTestOptions {
  /** Also exercise the live singleton (needs autoplay permission or a prior gesture). Default true. */
  live?: boolean;
  /** Analyser to use for the live check (else one is created). */
  analyser?: AnalyserNode | null;
  /** Progress callback (for the dev page). */
  onProgress?: (label: string) => void;
}

export async function runAudioSelfTest(opts: SelfTestOptions = {}): Promise<SelfTestReport> {
  const t0 = performance.now();
  const sounds: SoundResult[] = [];
  const layers: LayerResult[] = [];

  for (const c of ONE_SHOTS) {
    opts.onProgress?.(c.name);
    const errors: string[] = [];
    let r: Rendered | null = null;
    try {
      r = await render({ duration: c.duration, scene: 'game', setup: (core) => (firePublic(c, core) ? undefined : c.internal?.(core)) }, errors);
    } catch (e) {
      errors.push(errText(e));
    }
    sounds.push(soundResult(c.name, c.group, r, errors));
  }
  for (const c of LAYERS) {
    opts.onProgress?.(c.name);
    layers.push(await runLayer(c));
  }
  opts.onProgress?.('music');
  const music = await runMusic();
  sounds.push(...music.sounds);
  layers.push(...music.layers);
  layers.push(...(await runBehaviour(opts.onProgress)));
  opts.onProgress?.('robustness');
  layers.push(await runRobustness());
  layers.push(runStealing());
  opts.onProgress?.('worst case mix');
  sounds.push(await runMixStress());
  opts.onProgress?.('mock run');
  const mock = await runMockSim();
  sounds.push(mock.sound);
  layers.push(mock.drain);
  opts.onProgress?.('cpu');
  layers.push(await runCpu());
  let live: LiveResult | null = null;
  if (opts.live !== false) {
    opts.onProgress?.('live context');
    live = await runLive(opts.analyser);
  }

  const failures: string[] = [];
  for (const s of sounds) if (!s.pass) failures.push(`${s.name}: ${s.issues.join(', ')}`);
  for (const l of layers) if (!l.pass) failures.push(`${l.name}: ${l.detail}`);
  if (live && live.errors.length) failures.push(`live: ${live.errors.join('; ')}`);
  return { ok: failures.length === 0, sampleRate: SR, elapsedMs: Math.round(performance.now() - t0), sounds, layers, live, failures };
}
