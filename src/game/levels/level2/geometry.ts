/**
 * LEVEL 2 — CLEAR THE GAP: parametric track geometry (pure data, shared by the sim, the pilots,
 * the headless tests and the renderer).
 *
 * Side profile — the course runs straight towards −Z and descends the canyon in giant steps:
 *
 *   start ─ runway ─[K1]─ table ─╮                     ┌─[K2]─ table ─╮
 *                                ╰─ landing hill ──────┘               ╰─ hill ─ boost straight ─╮
 *                                                                                                 │
 *   ──╯ big launch ramp (27°) ·  ·  ·  ·  chasm  ·  ring gate  ·  ·  ·  ·  ╮ knuckle (−2 m)        │
 *                                                     catch shelf ▁▁▁▁▁ ╰─ ski-jump hill 12°→22°→30°→34°
 *                                                                                    ╰─ finish deck
 *
 * Design notes (tuned with headless sweeps, see tests/levels/level2.test.ts):
 *  - Kickers sit on a flat table; their landing hills are huge-radius knuckles (R 320–360 m), so a
 *    wide speed range lands CLEAN while the natural W-held speed gets ≈ 2.5 s of air (flip + recovery).
 *  - Near the big landing, every trajectory of the thrust family is a horizontal translation of the
 *    others: its descent angle depends almost only on height. The landing hill therefore steepens with
 *    depth (12° → 20° → 32°) so wherever a trajectory touches down the mismatch stays ≈ 8–12°.
 *  - A W-only launch (≈ 53 m/s) passes ≈ 10 m under the knuckle and crashes on the catch shelf: thrust is required.
 */
import { Vector3 } from 'three';
import { frameAt, TrackPath } from '../../track/TrackPath';
import type { BoxPieceDef, PieceDef, RibbonPieceDef, TrackFrame, V3 } from '../../types';

const DEG = Math.PI / 180;

export interface KickerParams {
  /** Flat deck between the previous section and the kicker start (m). */
  runIn: number;
  /** Lip angle (deg), transition radius (m) and straight lip length (m). */
  angle: number;
  radius: number;
  lip: number;
  /** Kicker drive width (m). */
  width: number;
  /** Flat table from the lip (measured horizontally) to the knuckle (m). */
  table: number;
  /** Max landing angle (deg) reached by the knuckle (radius m), straight slope length (m), bottom transition radius (m). */
  slope: number;
  knuckleRadius: number;
  slopeLength: number;
  bottomRadius: number;
}

export interface L2Params {
  /** Start deck height (m). */
  baseY: number;
  /** Runway from the start deck to the K1 kicker start (m). */
  runway: number;
  /** Deck / table width (m). */
  deckWidth: number;
  k1: KickerParams;
  k2: KickerParams;
  /** Flat boost straight after the K2 landing hill (m). */
  boostStraight: number;
  /** Big launch ramp: angle (deg), transition radius (m), straight lip (m), width (m). */
  bigAngle: number;
  bigRadius: number;
  bigLip: number;
  bigWidth: number;
  /** Chasm: horizontal distance lip → knuckle top (m) and knuckle height relative to the lip (m). */
  gap: number;
  knuckleRise: number;
  /** Landing hill: entry pitch at the knuckle (deg, downhill), then convex stages (angle deg / radius m). */
  landEntry: number;
  landA1: number;
  landR1: number;
  landA2: number;
  landR2: number;
  landA3: number;
  landR3: number;
  /** Straight at landA3 (m), bottom transition radius (m), finish deck length (m). */
  landStraight: number;
  landBottomRadius: number;
  finishLength: number;
  /** Landing hill width at the top / bottom (m). */
  landWidthTop: number;
  landWidthBottom: number;
}

export const L2_DEFAULTS: L2Params = {
  baseY: 97,
  runway: 120,
  deckWidth: 22,
  k1: { runIn: 0, angle: 16, radius: 70, lip: 4, width: 16, table: 40, slope: 24, knuckleRadius: 360, slopeLength: 10, bottomRadius: 150 },
  k2: { runIn: 60, angle: 14, radius: 80, lip: 4, width: 16, table: 70, slope: 24, knuckleRadius: 320, slopeLength: 10, bottomRadius: 180 },
  boostStraight: 220,
  bigAngle: 27,
  bigRadius: 140,
  bigLip: 8,
  bigWidth: 18,
  gap: 188,
  knuckleRise: -2,
  landEntry: 12,
  landA1: 22,
  landR1: 200,
  landA2: 30,
  landR2: 350,
  landA3: 34,
  landR3: 300,
  landStraight: 65,
  landBottomRadius: 170,
  finishLength: 240,
  landWidthTop: 48,
  landWidthBottom: 56,
};

/** A kicker feature: the ramp ribbon on its deck plus the backbone deck/table/hill frames. */
export interface KickerLayout {
  /** Kicker ramp ribbon frames (start on the deck surface, end at the lip). */
  ramp: TrackFrame[];
  lip: TrackFrame;
  /** Arc length (on the backbone path) of the kicker start / knuckle start / slope bottom end. */
  sStart: number;
  sKnuckle: number;
  sBottom: number;
  /** Height of the lip above its table (m). */
  lipHeight: number;
}

export interface L2Layout {
  params: L2Params;
  pieces: PieceDef[];
  /** Continuous drivable centerline from the start deck to the big lip (deck path, kickers excluded). */
  backbone: TrackFrame[];
  /** Landing hill + finish deck centerline. */
  landing: TrackFrame[];
  k1: KickerLayout;
  k2: KickerLayout;
  /** Big launch ramp frames (from its start to the lip) and the lip frame. */
  bigRamp: TrackFrame[];
  bigLip: TrackFrame;
  /** Arc lengths on `landing`: end of the convex hill (start of the straight) / start of the finish deck. */
  landStraightStart: number;
  landFinishStart: number;
  /** Catch shelf under the knuckle (collidable: an undershoot crashes into it). */
  shelf: BoxPieceDef;
  /** Arc length on the backbone where the runway / boost straight / big ramp start. */
  sRunwayStart: number;
  sBoostStart: number;
  sBigRampStart: number;
  /** Start platform length (m) at the beginning of the backbone. */
  startLength: number;
}

function ribbon(
  id: string,
  frames: TrackFrame[],
  width: number | ((s: number) => number),
  style: RibbonPieceDef['style'],
  extra: Partial<RibbonPieceDef> = {},
): RibbonPieceDef {
  return { kind: 'ribbon', id, frames, width, style, adhesive: false, ...extra };
}

/** Smoothstep width blend from a to b over [s0, s1] (arc length). */
function blendWidth(a: number, b: number, s0: number, s1: number): (s: number) => number {
  return (s) => {
    const t = Math.min(1, Math.max(0, (s - s0) / Math.max(1e-6, s1 - s0)));
    return a + (b - a) * t * t * (3 - 2 * t);
  };
}

/** Frames of `frames` with s in [s0, s1] (command ends are exact frames). */
function cut(frames: TrackFrame[], s0: number, s1: number): TrackFrame[] {
  return frames.filter((f) => f.s >= s0 - 1e-6 && f.s <= s1 + 1e-6);
}

export function buildL2Layout(p: L2Params = L2_DEFAULTS): L2Layout {
  const pieces: PieceDef[] = [];
  const W = p.deckWidth;

  // ---- start deck + runway ------------------------------------------------------------------------
  const START_LEN = 40;
  const back = new TrackPath({ position: [0, p.baseY, 20] });
  back.straight(START_LEN);
  const sRunwayStart = back.length;
  back.straight(p.runway);

  // ---- kickers -----------------------------------------------------------------------------------
  const kicker = (k: KickerParams): KickerLayout => {
    back.straight(k.runIn);
    const sStart = back.length;
    const start = back.end();
    const ramp = TrackPath.fromFrame(start).up(k.angle, k.radius).straight(k.lip);
    const lip = ramp.end();
    const lipHeight = lip.position.y - start.position.y;
    const rampRun = Math.abs(lip.position.z - start.position.z);
    back.straight(rampRun + k.table);
    const sKnuckle = back.length;
    back.down(k.slope, k.knuckleRadius).straight(k.slopeLength).up(k.slope, k.bottomRadius);
    return { ramp: ramp.frames, lip, sStart, sKnuckle, sBottom: back.length, lipHeight };
  };
  const k1 = kicker(p.k1);
  const k2 = kicker(p.k2);

  // ---- boost straight + big launch ramp ------------------------------------------------------------
  const sBoostStart = back.length;
  back.straight(p.boostStraight);
  const sBigRampStart = back.length;
  back.up(p.bigAngle, p.bigRadius).straight(p.bigLip);
  const bigLip = back.end();
  const backbone = back.frames;

  // ---- landing hill + finish deck --------------------------------------------------------------------
  const lipFwd = new Vector3(bigLip.forward.x, 0, bigLip.forward.z).normalize();
  const yawDeg = Math.atan2(-lipFwd.x, -lipFwd.z) / DEG;
  const knuckleTop = bigLip.position.clone().addScaledVector(lipFwd, p.gap);
  knuckleTop.y = bigLip.position.y + p.knuckleRise;
  const land = new TrackPath({ position: knuckleTop, yawDeg, pitchDeg: -p.landEntry });
  land.straight(6);
  land.down(p.landA1 - p.landEntry, p.landR1);
  land.down(p.landA2 - p.landA1, p.landR2);
  land.down(p.landA3 - p.landA2, p.landR3);
  const landStraightStart = land.length;
  land.straight(p.landStraight);
  land.up(p.landA3, p.landBottomRadius);
  const landFinishStart = land.length;
  land.straight(p.finishLength);
  const landing = land.frames;

  // ---- catch shelf under the knuckle ------------------------------------------------------------------
  // A wide concrete shelf 45 m below the knuckle top: an undershoot slams into it (crash) instead of
  // falling for seconds (even a car crawling off the lip arrives at ≥ 36 m/s: never a survivable landing).
  // It is horizontal on purpose — while a jump is heading for it the predicted
  // surface normal is world up, so flight assist / SHIFT keep the car level (a vertical wall face would
  // pitch the nose up towards the wall and skew the thrust direction).
  const SHELF_DROP = 45;
  const SHELF_T = 6;
  const shelfNear = p.gap - 32;
  const shelfFar = p.gap + 50;
  const shelfY = knuckleTop.y - SHELF_DROP - SHELF_T / 2;
  const shelfC = bigLip.position.clone().addScaledVector(lipFwd, (shelfNear + shelfFar) / 2);
  const shelf: BoxPieceDef = {
    kind: 'box',
    id: 'l2-shelf',
    center: [shelfC.x, shelfY, shelfC.z],
    size: [p.landWidthTop + 28, SHELF_T, shelfFar - shelfNear],
    rotationDeg: [0, yawDeg, 0],
    style: 'platform',
  };

  // ---- pieces (backbone split by style) -------------------------------------------------------------
  const startDeckW = 34;
  const sEnd = backbone[backbone.length - 1].s;
  // Low collidable safety rails on the long flat decks (not on landing hills or kickers).
  const RAIL = 0.8;
  pieces.push(ribbon('l2-start', cut(backbone, 0, sRunwayStart), blendWidth(startDeckW, W, START_LEN - 14, START_LEN), 'platform', { edgeLights: 'white' }));
  pieces.push(ribbon('l2-runway', cut(backbone, sRunwayStart, k1.sKnuckle), W, 'runway', { edgeLights: 'white', rails: RAIL }));
  pieces.push(ribbon('l2-hill1', cut(backbone, k1.sKnuckle, k1.sBottom), blendWidth(W, W + 12, k1.sKnuckle, k1.sKnuckle + 45), 'landing', { edgeLights: 'cyan' }));
  pieces.push(ribbon('l2-deck2', cut(backbone, k1.sBottom, k2.sKnuckle), blendWidth(W + 12, W, k1.sBottom, k1.sBottom + 40), 'runway', { edgeLights: 'white', rails: RAIL }));
  pieces.push(ribbon('l2-hill2', cut(backbone, k2.sKnuckle, k2.sBottom), blendWidth(W, W + 12, k2.sKnuckle, k2.sKnuckle + 45), 'landing', { edgeLights: 'cyan' }));
  pieces.push(ribbon('l2-boost', cut(backbone, k2.sBottom, sBigRampStart), blendWidth(W + 12, W, k2.sBottom, k2.sBottom + 40), 'runway', { edgeLights: 'white', rails: RAIL }));
  pieces.push(ribbon('l2-bigramp', cut(backbone, sBigRampStart, sEnd), blendWidth(W, p.bigWidth, sBigRampStart, sBigRampStart + 50), 'ramp', { edgeLights: 'orange', rails: RAIL }));
  pieces.push(ribbon('l2-kicker1', k1.ramp, p.k1.width, 'ramp', { edgeLights: 'orange', supports: false }));
  pieces.push(ribbon('l2-kicker2', k2.ramp, p.k2.width, 'ramp', { edgeLights: 'orange', supports: false }));
  const landW = blendWidth(p.landWidthTop, p.landWidthBottom, landStraightStart, landFinishStart);
  pieces.push(ribbon('l2-landing', cut(landing, 0, landFinishStart), landW, 'landing', { edgeLights: 'cyan' }));
  pieces.push(ribbon('l2-finishdeck', cut(landing, landFinishStart, landing[landing.length - 1].s), landW, 'platform', { edgeLights: 'cyan', rails: RAIL }));
  pieces.push(shelf);

  return {
    params: p,
    pieces,
    backbone,
    landing,
    k1,
    k2,
    bigRamp: cut(backbone, sBigRampStart, sEnd),
    bigLip,
    landStraightStart,
    landFinishStart,
    shelf,
    sRunwayStart,
    sBoostStart,
    sBigRampStart,
    startLength: START_LEN,
  };
}

/** Frame on a frame list at arc length s. */
export function frameOn(frames: TrackFrame[], s: number): TrackFrame {
  return frameAt(frames, s);
}

/** Point on a frame list at arc length s, raised `up` meters along the frame normal. */
export function pointOn(frames: TrackFrame[], s: number, up = 0): V3 {
  const f = frameAt(frames, s);
  const p = f.position.clone().addScaledVector(f.up, up);
  return [p.x, p.y, p.z];
}
