/**
 * LEVEL 2 — course constants derived from the geometry (positions of the key features), shared by
 * the LevelDef (zones, objectives, hints, intro), the reference pilot and the decor.
 */
import { Vector3 } from 'three';
import type { TrackFrame, V3 } from '../../types';
import { buildL2Layout, L2_DEFAULTS, type L2Layout } from './geometry';

export const L2_LAYOUT: L2Layout = buildL2Layout(L2_DEFAULTS);

const v3 = (p: Vector3): V3 => [p.x, p.y, p.z];

/** Frame on the landing path whose horizontal distance from the big lip is closest to `x` (m). */
function landingFrameAtX(layout: L2Layout, x: number): TrackFrame {
  const lipZ = layout.bigLip.position.z;
  let best = layout.landing[0];
  for (const f of layout.landing) if (Math.abs(lipZ - f.position.z - x) < Math.abs(lipZ - best.position.z - x)) best = f;
  return best;
}

export interface L2Course {
  layout: L2Layout;
  /** z of key features (the course runs straight along −Z at x = 0). */
  zSpawn: number;
  zK1Start: number;
  zK1Lip: number;
  zK2Start: number;
  zK2Lip: number;
  zBoostStart: number;
  zBigRampStart: number;
  zLip: number;
  zKnuckle: number;
  zFinishDeck: number;
  zEnd: number;
  /** Heights. */
  yStart: number;
  yLip: number;
  yKnuckle: number;
  yFinish: number;
  /** Ring gate: center and radius (m). */
  gate: V3;
  gateRadius: number;
  /** Landing target on the hill: frame at its center and its half extents (lateral, along). */
  target: TrackFrame;
  targetHalf: [number, number];
  killY: number;
}

export function computeCourse(layout: L2Layout = L2_LAYOUT): L2Course {
  const b = layout.backbone;
  const at = (s: number) => b.find((f) => f.s >= s - 1e-6) ?? b[b.length - 1];
  const lip = layout.bigLip.position;
  const knuckle = layout.landing[0].position;
  const finish = layout.landing.find((f) => f.s >= layout.landFinishStart - 1e-6)!.position;
  const end = layout.landing[layout.landing.length - 1].position;
  // ring gate: mid-gap, on the arc of a prompt full-tank burn (W speed + 0.5 s thrust right after the lip)
  const GATE_X = 100;
  const GATE_H = 26;
  const gate = new Vector3(lip.x, lip.y + GATE_H, lip.z - GATE_X);
  // target: where a prompt "hold SPACE" burn (0.15–0.75 s after the lip) lands PERFECT (≈ 75–125 m past the knuckle)
  const target = landingFrameAtX(layout, layout.params.gap + 100);
  return {
    layout,
    zSpawn: -5,
    zK1Start: at(layout.k1.sStart).position.z,
    zK1Lip: layout.k1.lip.position.z,
    zK2Start: at(layout.k2.sStart).position.z,
    zK2Lip: layout.k2.lip.position.z,
    zBoostStart: at(layout.sBoostStart).position.z,
    zBigRampStart: at(layout.sBigRampStart).position.z,
    zLip: lip.z,
    zKnuckle: knuckle.z,
    zFinishDeck: finish.z,
    zEnd: end.z,
    yStart: b[0].position.y,
    yLip: lip.y,
    yKnuckle: knuckle.y,
    yFinish: finish.y,
    gate: v3(gate),
    gateRadius: 6,
    target,
    targetHalf: [15, 30],
    killY: Math.round(finish.y - 52),
  };
}

export const L2_COURSE: L2Course = computeCourse(L2_LAYOUT);
