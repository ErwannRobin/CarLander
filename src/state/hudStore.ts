/**
 * HUD data store — a plain-data, display-ready copy of the simulation snapshot.
 *
 * The integration calls `publishHud(snapshot)` at ~30 Hz. Values are rounded to display
 * precision and nested groups keep their previous object identity when unchanged, so React
 * components selecting a group only re-render when what they show actually changes.
 * Nothing in this store references the sim's mutable Vector3 / Quaternion / arrays, and
 * non-finite numbers (NaN / Infinity) are replaced by safe fallbacks before they reach the DOM.
 *
 * `useAppStore.startLevel()` / `restart()` call `resetHud()` before the run changes, so the
 * previous run's phase / objective / score never flash at the start of the next one.
 */
import { create } from 'zustand';
import { KMH, TUNING } from '@/game/tuning';
import type {
  ControlHint,
  CrashReason,
  LandingPrediction,
  LandingQuality,
  LevelId,
  PromptState,
  SimPhase,
  SimSnapshot,
  TrickInstance,
  TrickKind,
  VacuumMode,
} from '@/game/types';

export interface HudTrick {
  kind: TrickKind;
  label: string;
  count: number;
  points: number;
}

export interface HudObjective {
  index: number;
  total: number;
  id: string;
  title: string;
  text: string;
  hints: readonly ControlHint[];
  complete: boolean;
}

export interface HudPrompt {
  id: string;
  text: string;
  hint: ControlHint | null;
  tone: PromptState['tone'];
}

export interface HudVacuum {
  available: boolean;
  mode: VacuumMode;
  /** 0..1, 2 decimals. */
  strength: number;
  /** Underbody → surface distance (m, 1 decimal) or null when no compatible surface is in range. */
  distance: number | null;
  hasSurface: boolean;
}

/** Attitude vs the predicted landing surface (airborne only). */
export interface HudAttitude {
  valid: boolean;
  /** + = nose too high (deg, 1 decimal). */
  pitchErrorDeg: number;
  /** + = rolled right (deg, 1 decimal). */
  rollErrorDeg: number;
  alignmentDeg: number;
  quality: LandingQuality | null;
  timeToImpact: number;
  inTarget: boolean;
}

export interface HudScore {
  total: number;
  /** Consecutive quick non-crash landings. */
  chain: number;
  comboMultiplier: number;
  jumps: number;
  tricks: number;
}

export interface HudState {
  /** True once publishHud ran since the last reset. */
  live: boolean;
  levelId: LevelId;
  phase: SimPhase;
  /** Sim seconds since (re)start. */
  time: number;
  timeScale: number;

  speedKmh: number;
  /** speed / maxSpeedBoost, 0..1 (gauge fill). */
  speedFrac: number;
  boosting: boolean;
  /** 0..1 smoothed thrust level. */
  boostLevel: number;
  /** 0..1 remaining thrust fuel (2 decimals). */
  fuel: number;
  /** 0..100 integer. */
  fuelPct: number;
  stabilizing: boolean;

  airborne: boolean;
  /** Height above the surface below (m, 1 decimal); null if nothing below. */
  altitude: number | null;
  airTime: number;
  /** Horizontal distance since takeoff (m, integer). */
  distance: number;
  maxHeight: number;
  /** Points at stake if the car lands cleanly. */
  pendingPoints: number;
  airTricks: readonly HudTrick[];
  /** Per-jump trick combo multiplier: 1 + 0.5·(distinct tricks − 1). */
  airCombo: number;

  attitude: HudAttitude;
  predictedQuality: LandingQuality | null;
  vacuum: HudVacuum;
  objective: HudObjective;
  prompt: HudPrompt | null;
  score: HudScore;
  crashReason: CrashReason | null;
}

const NO_ATTITUDE: HudAttitude = Object.freeze({
  valid: false,
  pitchErrorDeg: 0,
  rollErrorDeg: 0,
  alignmentDeg: 0,
  quality: null,
  timeToImpact: 0,
  inTarget: false,
});

const NO_TRICKS: readonly HudTrick[] = Object.freeze([]);

function initialHud(): HudState {
  return {
    live: false,
    levelId: 1,
    phase: 'ready',
    time: 0,
    timeScale: 1,
    speedKmh: 0,
    speedFrac: 0,
    boosting: false,
    boostLevel: 0,
    fuel: 1,
    fuelPct: 100,
    stabilizing: false,
    airborne: false,
    altitude: null,
    airTime: 0,
    distance: 0,
    maxHeight: 0,
    pendingPoints: 0,
    airTricks: NO_TRICKS,
    airCombo: 1,
    attitude: NO_ATTITUDE,
    predictedQuality: null,
    vacuum: { available: false, mode: 'off', strength: 0, distance: null, hasSurface: false },
    objective: { index: 0, total: 0, id: '', title: '', text: '', hints: [], complete: false },
    prompt: null,
    score: { total: 0, chain: 0, comboMultiplier: 1, jumps: 0, tricks: 0 },
    crashReason: null,
  };
}

export const useHudStore = create<HudState>()(() => initialHud());

/* ------------------------------------------------------------------ */
/* publish                                                             */
/* ------------------------------------------------------------------ */

/** Finite value or `fallback` — a NaN / Infinity from the sim must never reach the DOM. */
const fin = (v: number, fallback = 0) => (Number.isFinite(v) ? v : fallback);
const r1 = (v: number) => Math.round(fin(v) * 10) / 10;
const r2 = (v: number) => Math.round(fin(v) * 100) / 100;
const int = (v: number) => Math.round(fin(v));

function sameStrings(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameHint(a: ControlHint | null, b: ControlHint | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.label === b.label && sameStrings(a.keys, b.keys) && sameStrings(a.actions, b.actions);
}

function sameHints(a: readonly ControlHint[], b: readonly ControlHint[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameHint(a[i], b[i])) return false;
  return true;
}

function copyHint(h: ControlHint): ControlHint {
  return h.actions ? { keys: [...h.keys], label: h.label, actions: [...h.actions] } : { keys: [...h.keys], label: h.label };
}

function sameTricks(prev: readonly HudTrick[], next: readonly TrickInstance[]): boolean {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (a.label !== b.label || a.points !== int(b.points) || a.count !== b.count || a.kind !== b.kind) return false;
  }
  return true;
}

function distinctKinds(tricks: readonly TrickInstance[]): number {
  let n = 0;
  for (let i = 0; i < tricks.length; i++) {
    let seen = false;
    for (let j = 0; j < i; j++) {
      if (tricks[j].kind === tricks[i].kind) {
        seen = true;
        break;
      }
    }
    if (!seen) n++;
  }
  return n;
}

function attitudeFrom(prev: HudAttitude, p: LandingPrediction | null, airborne: boolean): HudAttitude {
  if (!airborne || !p || !p.valid) return NO_ATTITUDE;
  const pitch = r1(p.pitchErrorDeg);
  const roll = r1(p.rollErrorDeg);
  const align = r1(p.alignmentDeg);
  const tti = r1(Math.max(0, fin(p.timeToImpact)));
  if (
    prev.valid &&
    prev.pitchErrorDeg === pitch &&
    prev.rollErrorDeg === roll &&
    prev.alignmentDeg === align &&
    prev.quality === p.predictedQuality &&
    prev.timeToImpact === tti &&
    prev.inTarget === p.inTarget
  ) {
    return prev;
  }
  return {
    valid: true,
    pitchErrorDeg: pitch,
    rollErrorDeg: roll,
    alignmentDeg: align,
    quality: p.predictedQuality,
    timeToImpact: tti,
    inTarget: p.inTarget,
  };
}

/** Copy everything the HUD needs from the sim snapshot. Call at ~30 Hz. */
export function publishHud(snapshot: SimSnapshot): void {
  const prev = useHudStore.getState();
  const v = snapshot.vehicle;
  const air = snapshot.air;

  // vacuum
  const vs = v.vacuum;
  const vacStrength = r2(Math.min(1, Math.max(0, fin(vs.strength))));
  const vacDistance = vs.hasSurface && Number.isFinite(vs.distance) ? r1(vs.distance) : null;
  const pv = prev.vacuum;
  const vacuum =
    pv.available === vs.available &&
    pv.mode === vs.mode &&
    pv.strength === vacStrength &&
    pv.distance === vacDistance &&
    pv.hasSurface === vs.hasSurface
      ? pv
      : { available: vs.available, mode: vs.mode, strength: vacStrength, distance: vacDistance, hasSurface: vs.hasSurface };

  // objective
  const o = snapshot.objective;
  const po = prev.objective;
  const objective =
    po.index === o.index &&
    po.total === o.total &&
    po.id === o.id &&
    po.title === o.title &&
    po.text === o.text &&
    po.complete === o.complete &&
    sameHints(po.hints, o.hints)
      ? po
      : { index: o.index, total: o.total, id: o.id, title: o.title, text: o.text, hints: o.hints.map(copyHint), complete: o.complete };

  // prompt
  const sp = snapshot.prompt;
  const pp = prev.prompt;
  let prompt: HudPrompt | null;
  if (!sp) prompt = null;
  else if (pp && pp.id === sp.id && pp.text === sp.text && pp.tone === sp.tone && sameHint(pp.hint, sp.hint)) prompt = pp;
  else prompt = { id: sp.id, text: sp.text, hint: sp.hint ? copyHint(sp.hint) : null, tone: sp.tone };

  // score
  const sc = snapshot.score;
  const ps = prev.score;
  const total = int(sc.total);
  const chain = int(sc.chain);
  const combo = r2(fin(sc.comboMultiplier, 1));
  const jumps = int(sc.jumps);
  const tricks = int(sc.tricks);
  const score =
    ps.total === total && ps.chain === chain && ps.comboMultiplier === combo && ps.jumps === jumps && ps.tricks === tricks
      ? ps
      : { total, chain, comboMultiplier: combo, jumps, tricks };

  // air tricks
  const airTricks: readonly HudTrick[] =
    air.tricks.length === 0
      ? NO_TRICKS
      : sameTricks(prev.airTricks, air.tricks)
        ? prev.airTricks
        : air.tricks.map((t) => ({ kind: t.kind, label: t.label, count: t.count, points: int(t.points) }));

  const attitude = attitudeFrom(prev.attitude, snapshot.prediction, air.airborne);
  const speed = Math.max(0, fin(v.speed));
  const fuel = r2(Math.min(1, Math.max(0, fin(v.fuel, 1))));
  const height = air.height;

  useHudStore.setState({
    live: true,
    levelId: snapshot.levelId,
    phase: snapshot.phase,
    time: r1(Math.max(0, fin(snapshot.time))),
    timeScale: r2(fin(snapshot.timeScale, 1)),
    speedKmh: Math.round(speed * KMH),
    speedFrac: r2(Math.min(1, speed / TUNING.maxSpeedBoost)),
    boosting: v.boosting,
    boostLevel: r2(Math.min(1, Math.max(0, fin(v.boostLevel)))),
    fuel,
    fuelPct: Math.round(fuel * 100),
    stabilizing: v.stabilizing,
    airborne: air.airborne,
    altitude: Number.isFinite(height) ? r1(Math.max(0, height)) : null,
    airTime: r2(Math.max(0, fin(air.airTime))),
    distance: Math.max(0, int(air.distance)),
    maxHeight: r1(air.maxHeight),
    pendingPoints: Math.max(0, int(air.pendingPoints)),
    airTricks,
    airCombo: airTricks.length > 1 ? 1 + 0.5 * (distinctKinds(air.tricks) - 1) : 1,
    attitude,
    predictedQuality: attitude.valid ? attitude.quality : null,
    vacuum,
    objective,
    prompt,
    score,
    crashReason: snapshot.crashReason,
  });
}

/** Reset the HUD to its empty state (e.g. when leaving gameplay or switching level). */
export function resetHud(): void {
  useHudStore.setState(initialHud(), true);
}
