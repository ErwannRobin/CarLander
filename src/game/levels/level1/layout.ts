/**
 * LEVEL 1 — LEARN TO FLY: track geometry (shared by the LevelDef, the reference pilot, the tests and
 * the decor, so scenery always lines up with the gameplay pieces).
 *
 * Side profile (runway level y = 0, progress toward −Z):
 *
 *   runway 26 m wide ───────────── funnel → 16 m ── kicker 17° ─ lip    open gap over the clouds
 *   ═══════════════════════════════════════════════╱‾‾                ·  ·  ·  ·
 *                                                                      landing deck: a gentle knoll,
 *                                                                      a soft landing slope under the
 *                                                                      target rings, then the flat
 *                                                                      finish run-out
 *
 * The deck profile is a slope schedule (arc length, downhill slope) — consecutive control points are
 * joined by circular arcs — tuned with the headless autopilot sweeps (tests/levels/level1.test.ts):
 *  - full throttle without thrust (≈ 55 m/s at the lip) lands on the apron, short of the target;
 *  - full throttle + a burn after the lip lands in the target.
 */
import { Vector3 } from 'three';
import { TrackPath } from '../../track/TrackPath';
import type { TrackFrame, V3 } from '../../types';

const DEG = Math.PI / 180;

export interface L1Params {
  /** Runway length (m) including the funnel. */
  runwayLength: number;
  runwayWidth: number;
  /** Last meters of the runway that narrow to the kicker width. */
  funnelLength: number;
  kickerWidth: number;
  /** Kicker: soft entry arc then the main arc to `kickerAngle`, then a short straight lip. */
  kickerEntryDeg: number;
  kickerEntryRadius: number;
  kickerAngle: number;
  kickerRadius: number;
  kickerLip: number;
  /** Horizontal distance lip → deck start (m) and the deck start height below the lip (m). */
  gap: number;
  deckDrop: number;
  deckWidth: number;
  /** Deck slope schedule: [arc length (m), downhill slope (deg)], first at 0, last = deck end. */
  deckSlopes: [number, number][];
  /** Arc length where the apron (platform surface) hands over to the landing hill — must be a control point. */
  apronLength: number;
  /** Target zone extent along the deck (arc length, m) and half width (m). */
  targetStart: number;
  targetEnd: number;
  targetHalfWidth: number;
}

export const L1_DEFAULTS: L1Params = {
  runwayLength: 380,
  runwayWidth: 26,
  funnelLength: 70,
  kickerWidth: 16,
  kickerEntryDeg: 4,
  kickerEntryRadius: 300,
  kickerAngle: 17,
  kickerRadius: 140,
  kickerLip: 3,
  gap: 75,
  deckDrop: 1.5,
  deckWidth: 34,
  // table (apron at lip height) → crest (R ≈ 330 m: no hop at landing speeds) → landing slope
  // steepening from 12.5° to 16° → outrun → flat finish deck
  deckSlopes: [
    [0, 1],
    [50, 1.5],
    [70, 5.5], // (on the crest arc: only marks the apron / hill seam)
    [105, 12.5],
    [140, 14.5],
    [190, 15.5],
    [230, 16],
    [300, 0],
    [520, 0],
  ],
  apronLength: 70,
  targetStart: 80,
  targetEnd: 200,
  targetHalfWidth: 13,
};

export interface L1Layout {
  params: L1Params;
  runway: TrackPath;
  kicker: TrackPath;
  /** Whole landing deck (apron + hill) — one centerline for tracking. */
  deck: TrackPath;
  /** Frames of the apron (table at lip height, platform surface) and of the landing hill (landing surface). */
  apronFrames: TrackFrame[];
  hillFrames: TrackFrame[];
  runwayWidthAt: (s: number) => number;
  /** Lip frame (end of the kicker). */
  lip: TrackFrame;
  /** Deck start frame. */
  deckStart: TrackFrame;
  /** Arc length (on the deck) of the target start / center / end. */
  targetS: { start: number; center: number; end: number };
  /** World z of the runway start / end. */
  runwayStartZ: number;
  runwayEndZ: number;
}

const smooth = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

export function buildL1Layout(over: Partial<L1Params> = {}): L1Layout {
  const p: L1Params = { ...L1_DEFAULTS, ...over };
  const runwayStartZ = 0;
  const runway = new TrackPath({ position: [0, 0, runwayStartZ] }, 2).straight(p.runwayLength);
  const funnelStart = p.runwayLength - p.funnelLength;
  const runwayWidthAt = (s: number) => p.runwayWidth + (p.kickerWidth - p.runwayWidth) * smooth((s - funnelStart) / p.funnelLength);

  const kicker = TrackPath.fromFrame(runway.end())
    .up(p.kickerEntryDeg, p.kickerEntryRadius)
    .up(p.kickerAngle - p.kickerEntryDeg, p.kickerRadius)
    .straight(p.kickerLip);
  const lip = kicker.end();

  const deckPos = new Vector3(0, lip.position.y - p.deckDrop, lip.position.z - p.gap);
  const sl = p.deckSlopes;
  const deck = new TrackPath({ position: deckPos, pitchDeg: -sl[0][1] }, 2);
  for (let i = 1; i < sl.length; i++) {
    const [s0, a0] = sl[i - 1];
    const [s1, a1] = sl[i];
    // downhill slope a → pitch −a; constant curvature between control points (circular arc)
    deck.curve({ length: s1 - s0, pitchDeg: -(a1 - a0) });
  }
  const seam = deck.frames.findIndex((f) => Math.abs(f.s - p.apronLength) < 1e-6);
  if (seam <= 0) throw new Error(`L1 layout: apronLength ${p.apronLength} must be a deckSlopes control point`);
  const apronFrames = deck.frames.slice(0, seam + 1);
  const hillFrames = deck.frames.slice(seam);

  return {
    params: p,
    runway,
    kicker,
    deck,
    apronFrames,
    hillFrames,
    runwayWidthAt,
    lip,
    deckStart: deck.at(0),
    targetS: { start: p.targetStart, center: (p.targetStart + p.targetEnd) / 2, end: p.targetEnd },
    runwayStartZ,
    runwayEndZ: runway.end().position.z,
  };
}

/** Horizontal distance from the lip (m) of a world point (along −Z). */
export function distFromLip(layout: L1Layout, p: Vector3 | V3): number {
  const z = p instanceof Vector3 ? p.z : p[2];
  return layout.lip.position.z - z;
}

/** Deck slope (deg, + = downhill) at arc length s. */
export function deckSlopeAt(layout: L1Layout, s: number): number {
  return -Math.asin(Math.max(-1, Math.min(1, layout.deck.at(s).forward.y))) / DEG;
}

/** Deck arc length whose frame is closest to a horizontal distance from the lip. */
export function deckSAtDist(layout: L1Layout, d: number): number {
  const z = layout.lip.position.z - d;
  const f = layout.deck.frames;
  let best = 0;
  let bestErr = Infinity;
  for (const fr of f) {
    const e = Math.abs(fr.position.z - z);
    if (e < bestErr) {
      bestErr = e;
      best = fr.s;
    }
  }
  return best;
}
