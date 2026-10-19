/**
 * LEVEL 2 — KICKFLIP: geometry (shared by the LevelDef, the reference pilot, the tuning test and the decor).
 *
 * Reuses the Level 1 builder with the kicker flattened to nothing: one flat road — runway, then a
 * parking-lot strip, then the landing hill. Five parked cars stand broadside on the lot; the player
 * hops over them with the jump jets (F), does a kickflip (a full barrel roll, Q / E) and lands.
 */
import { buildL1Layout, type L1Layout, type L1Params } from '../level1/layout';
import type { V3 } from '../../types';

export const KF_PARAMS: Partial<L1Params> = {
  runwayLength: 220,
  runwayWidth: 22,
  funnelLength: 60,
  kickerWidth: 22,
  // no ramp: the "kicker" is a zero-length flat extension of the runway
  kickerEntryDeg: 0,
  kickerEntryRadius: 200,
  kickerAngle: 0,
  kickerRadius: 90,
  kickerLip: 0,
  gap: 46,
  deckDrop: 1,
  deckWidth: 30,
  deckSlopes: [
    [0, 1],
    [30, 3],
    [55, 12],
    [90, 16],
    [150, 18],
    [200, 0],
    [320, 0],
  ],
  apronLength: 30,
  targetStart: 40,
  targetEnd: 175,
  targetHalfWidth: 14,
};

export const KF: L1Layout = buildL1Layout(KF_PARAMS);

/**
 * The lineup (after the Tesla "Kickflip" stunt), in jump order from the runway: a small two-seat cab,
 * an angular pickup, a tall semi-truck cab, then two sedans. All stand broadside, nose to the +X side.
 * size = collision/visual envelope [length, height, width] (m).
 */
export type KfVehicleKind = 'cab' | 'pickup' | 'semi' | 'sedan';
export interface KfVehicle {
  kind: KfVehicleKind;
  /** Footprint center on the lot (y = lot top). */
  position: V3;
  yawDeg: number;
  paint: string;
  size: V3;
}

const LINEUP: { kind: KfVehicleKind; paint: string; size: V3 }[] = [
  { kind: 'cab', paint: '#b8a27a', size: [3.7, 1.15, 1.75] },
  { kind: 'pickup', paint: '#9aa0a6', size: [5.7, 1.9, 2.2] },
  { kind: 'semi', paint: '#eef0f2', size: [6.4, 3.9, 2.6] },
  { kind: 'sedan', paint: '#b0111e', size: [4.6, 1.15, 1.95] },
  { kind: 'sedan', paint: '#1f3f8f', size: [4.6, 1.15, 1.95] },
];
export const KF_CAR_COUNT = LINEUP.length;
const ROW_GAP = 0.7;

const lipZ = KF.lip.position.z;
const deckZ = KF.deckStart.position.z;
/** Lot midpoint (world z). */
export const KF_GAP_MID_Z = (lipZ + deckZ) / 2;
/** Parking-lot top surface height (runway level). */
export const KF_LOT_Y = 0;

const rowLen = LINEUP.reduce((a, v) => a + v.size[2], 0) + ROW_GAP * (LINEUP.length - 1);
let cursor = KF_GAP_MID_Z + rowLen / 2; // first vehicle nearest the runway (larger z)
export const KF_CARS: KfVehicle[] = LINEUP.map((v) => {
  const z = cursor - v.size[2] / 2;
  cursor -= v.size[2] + ROW_GAP;
  return { ...v, position: [0, KF_LOT_Y, z] as V3, yawDeg: 0 };
});
