/**
 * Parametric description of the hero car body.
 *
 * The body is a loft of cross-sections along the chassis Z axis (nose at -Z, tail at +Z). Each
 * section (right half, mirrored for the left) is a C1 chain of three curves:
 *
 *   sill corner (wb, ySill) --lower superellipse--> belt (w, yb)        [tumble-under]
 *   belt (w, yb)           --side superellipse --> shoulder (xs, ys)    [fender / haunch roll]
 *   shoulder (xs, ys)      --smooth crown      --> centre top (0, yt)   [hood / deck]
 *
 * Every parameter is a monotone spline of z, authored from a handful of key values below, which
 * produces the long low nose, crowned front fenders, waisted doors, strong rear haunches and the
 * Kamm tail with a ducktail lip. Wheel arches are U-shaped cut-outs (circle above the axle,
 * vertical below) evaluated in side view around each wheel centre.
 *
 * Chassis frame: right = +X, up = +Y, forward = -Z, origin at axle height mid-wheelbase.
 */
import { VEHICLE, WHEEL_POSITIONS } from '@/game/vehicleSpec';
import { clamp, MonotoneSpline, Polyline2, smoothstep } from './math';

export const Z_NOSE: number = VEHICLE.noseZ;
export const Z_TAIL: number = VEHICLE.tailZ;
export const WHEEL_Z_FRONT: number = WHEEL_POSITIONS[0][2];
export const WHEEL_Z_REAR: number = WHEEL_POSITIONS[2][2];
/** Side-view radius of the wheel-arch cut-out (wheel radius 0.36 + clearance). */
export const ARCH_RADIUS = 0.42;
/** Inner tub half-widths (inside the arches). Front leaves room for steering lock. */
export const TUB_FRONT = 0.54;
export const TUB_REAR = 0.64;
/** Nose cap: plan-view rounding of the front between NOSE_CAP_Z and the nose tip. */
const NOSE_CAP_Z = -1.86;
const NOSE_CAP_P = 3.0;
/** Kamm tail: radius of the rounded edge where the paint turns onto the rear face. */
export const TAIL_EDGE_R = 0.04;
/** The satin-black lower body stops short of the tail so the rear fascia can be recessed. */
export const LOWER_TAIL_Z = Z_TAIL - 0.025;
export const LOWER_NOSE_Z = Z_NOSE + 0.018;

type Key = readonly [number, number];
const S = (keys: Key[]) => new MonotoneSpline(keys);

// --- plan view ---------------------------------------------------------------------------
/** Belt (max) half width, before the nose cap. */
const W = S([
  [-2.23, 0.9],
  [-2.0, 0.935],
  [-1.75, 0.968],
  [-1.45, 0.988],
  [-1.2, 0.984],
  [-0.92, 0.95],
  [-0.5, 0.918],
  [-0.05, 0.91],
  [0.42, 0.93],
  [0.85, 0.972],
  [1.2, 0.99],
  [1.55, 0.99],
  [1.9, 0.975],
  [2.23, 0.952],
]);
/** Shoulder x as a fraction of the belt half width. */
const XS_FRAC = S([
  [-2.23, 0.7],
  [-1.6, 0.745],
  [-1.2, 0.76],
  [-0.6, 0.775],
  [0.3, 0.78],
  [0.95, 0.705],
  [1.4, 0.67],
  [2.0, 0.68],
  [2.23, 0.72],
]);
/** How far the section tucks under from the belt to the sill corner. */
const TUMBLE = S([
  [-2.23, 0.06],
  [-1.6, 0.1],
  [-0.9, 0.12],
  [0.5, 0.13],
  [1.4, 0.12],
  [2.23, 0.08],
]);

// --- side view ---------------------------------------------------------------------------
/** Height of the widest point (belt). High over the wheels, lower along the doors. */
const YB = S([
  [-2.23, 0.035],
  [-2.06, 0.11],
  [-1.82, 0.25],
  [-1.52, 0.355],
  [-1.36, 0.375],
  [-1.15, 0.35],
  [-0.9, 0.27],
  [-0.5, 0.2],
  [0.0, 0.185],
  [0.5, 0.225],
  [0.9, 0.31],
  [1.25, 0.38],
  [1.6, 0.395],
  [1.95, 0.385],
  [2.23, 0.37],
]);
/** Shoulder (fender peak / haunch) height. */
const YS = S([
  [-2.23, 0.072],
  [-2.15, 0.13],
  [-1.85, 0.296],
  [-1.55, 0.41],
  [-1.32, 0.441],
  [-1.05, 0.433],
  [-0.85, 0.412],
  [-0.5, 0.386],
  [0.0, 0.378],
  [0.5, 0.412],
  [0.9, 0.492],
  [1.25, 0.556],
  [1.55, 0.566],
  [1.9, 0.546],
  [2.23, 0.506],
]);
/** Centre-line top (hood, cowl, deck under the canopy, ducktail). */
const YT = S([
  [-2.23, 0.07],
  [-2.17, 0.106],
  [-2.0, 0.176],
  [-1.6, 0.285],
  [-1.36, 0.343],
  [-1.1, 0.366],
  [-0.88, 0.375],
  [-0.5, 0.362],
  [0.4, 0.362],
  [0.9, 0.39],
  [1.36, 0.42],
  [1.8, 0.44],
  [2.08, 0.455],
  [2.23, 0.482],
]);
/** Exponent shaping the hood/deck crown: > 1 keeps the centre flat and lifts near the shoulder. */
const CROWN_EXP = S([
  [-2.23, 1.15],
  [-1.6, 1.3],
  [-1.0, 1.3],
  [-0.4, 1.2],
  [0.6, 1.15],
  [1.3, 1.5],
  [2.23, 1.3],
]);
/** Side (belt -> shoulder) superellipse exponent: larger = fuller, more muscular fender roll. */
const N_SIDE = S([
  [-2.23, 2.4],
  [-1.4, 2.9],
  [-0.4, 2.8],
  [0.6, 2.8],
  [1.4, 3.0],
  [2.23, 2.7],
]);
/** Lower (belt -> sill) superellipse exponent. */
const N_LOW = S([
  [-2.23, 2.4],
  [0, 2.7],
  [2.23, 2.4],
]);
/** Floor height (rises at the nose for approach and at the tail for the diffuser). */
const Y_FLOOR = S([
  [-2.23, -0.185],
  [-1.95, -0.22],
  [-1.65, -0.24],
  [1.72, -0.24],
  [2.0, -0.218],
  [2.23, -0.2],
]);
/**
 * Two-tone split line ("lip"): paint above, recessed satin black below. Drops to the front
 * intake, sits at axle height along the sills, sweeps up into a dark side intake ahead of the rear
 * wheel and wraps the rear fascia. Wheel arches override it (see lipY()).
 */
const LIP_BASE = S([
  [-2.23, -0.075],
  [-2.08, -0.072],
  [-1.92, -0.05],
  [-1.79, -0.02],
  [-0.93, -0.06],
  [-0.5, -0.07],
  [0.0, -0.062],
  [0.35, -0.025],
  [0.65, 0.055],
  [0.93, 0.13],
  [1.79, 0.2],
  [2.0, 0.2],
  [2.23, 0.2],
]);
/** Depth of the black recess below the lip (deeper in the side intake ahead of the rear wheel). */
const LIP_INSET = S([
  [-2.23, 0.012],
  [-0.1, 0.012],
  [0.35, 0.028],
  [0.8, 0.045],
  [0.95, 0.04],
  [1.5, 0.014],
  [2.23, 0.012],
]);

export interface SectionParams {
  z: number;
  w: number;
  yb: number;
  xs: number;
  ys: number;
  yt: number;
  wb: number;
  ySill: number;
  yFloor: number;
  nSide: number;
  nLow: number;
  crownExp: number;
}

/** Plan-view rounding factor for the nose (1 = full width, 0 at the tip). */
export function noseCap(z: number, noseZ: number = Z_NOSE): number {
  const u = clamp((NOSE_CAP_Z - z) / (NOSE_CAP_Z - noseZ), 0, 1);
  return Math.pow(Math.max(0, 1 - Math.pow(u, NOSE_CAP_P)), 1 / NOSE_CAP_P);
}

/** Plan-view taper of the tail (rounds the rear corners before the Kamm face). */
const TAIL_TAPER_Z = 1.9;
const TAIL_TAPER = 0.075;
export function tailCap(z: number): number {
  const u = clamp((z - TAIL_TAPER_Z) / (Z_TAIL - TAIL_TAPER_Z), 0, 1);
  return 1 - TAIL_TAPER * Math.pow(u, 2.3);
}

export function sectionAt(z: number, noseZ: number = Z_NOSE): SectionParams {
  const cap = noseCap(z, noseZ) * tailCap(z);
  const w = W.at(z) * cap;
  const yFloor = Y_FLOOR.at(z);
  return {
    z,
    w,
    yb: YB.at(z),
    xs: XS_FRAC.at(z) * w,
    ys: YS.at(z),
    yt: YT.at(z),
    wb: Math.max(0, w - TUMBLE.at(z) * cap),
    ySill: yFloor + 0.03,
    yFloor,
    nSide: N_SIDE.at(z),
    nLow: N_LOW.at(z),
    crownExp: CROWN_EXP.at(z),
  };
}

/** Hood/deck crown profile: 0 at the centre line, 1 at the shoulder, flat tangents at both ends. */
function crown(u: number, e: number): number {
  const t = Math.pow(clamp(u, 0, 1), e);
  return t * t * (3 - 2 * t);
}

const LOW_SAMPLES = 36;
const SIDE_SAMPLES = 44;
const TOP_SAMPLES = 44;

/**
 * Dense polyline of the right-half outer section, from the sill corner up to the centre top.
 * `inset` offsets the curve towards the inside along its 2D normal (used for the Kamm tail edge).
 */
export function outerCurve(sec: SectionParams, inset = 0): Polyline2 {
  const pts: number[] = [];
  const { w, yb, xs, ys, yt, wb, ySill, nSide, nLow, crownExp } = sec;
  for (let k = 0; k <= LOW_SAMPLES; k++) {
    const phi = (Math.PI / 2) * (1 - k / LOW_SAMPLES);
    const c = Math.pow(Math.cos(phi), 2 / nLow);
    const s = Math.pow(Math.sin(phi), 2 / nLow);
    pts.push(wb + (w - wb) * c, yb - (yb - ySill) * s);
  }
  for (let k = 1; k <= SIDE_SAMPLES; k++) {
    const th = (Math.PI / 2) * (k / SIDE_SAMPLES);
    const c = Math.pow(Math.max(0, Math.cos(th)), 2 / nSide);
    const s = Math.pow(Math.sin(th), 2 / nSide);
    pts.push(xs + (w - xs) * c, yb + (ys - yb) * s);
  }
  for (let k = 1; k <= TOP_SAMPLES; k++) {
    const u = 1 - k / TOP_SAMPLES;
    pts.push(xs * u, yt + (ys - yt) * crown(u, crownExp));
  }
  const poly = new Polyline2();
  const n = pts.length / 2;
  if (inset <= 0) {
    for (let i = 0; i < n; i++) poly.push(pts[i * 2], pts[i * 2 + 1]);
    return poly;
  }
  // Offset along the inward normal (left of travel: the curve runs counter-clockwise).
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(n - 1, i + 1);
    let tx = pts[i1 * 2] - pts[i0 * 2];
    let ty = pts[i1 * 2 + 1] - pts[i0 * 2 + 1];
    const l = Math.hypot(tx, ty) || 1;
    tx /= l;
    ty /= l;
    let x = pts[i * 2] - ty * inset;
    const y = pts[i * 2 + 1] + tx * inset;
    // keep the centre line on x = 0 so the mirrored halves meet
    if (i === n - 1) x = 0;
    poly.push(Math.max(0, x), y);
  }
  return poly;
}

/** Paint inset for the rounded Kamm-tail edge (quarter-circle profile over the last TAIL_EDGE_R). */
export function tailInset(z: number): number {
  const s = clamp((z - (Z_TAIL - TAIL_EDGE_R)) / TAIL_EDGE_R, 0, 1);
  return TAIL_EDGE_R * (1 - Math.sqrt(Math.max(0, 1 - s * s)));
}

/**
 * How much lower the arch ceiling sits at the inner tub wall than at the outer lip (at the crown).
 * Small enough to leave the tyre crown room at full visual bump, large enough to keep the liner
 * under the hood / deck skin (min margin 6.8 mm front, 62 mm rear, near the outer lip).
 */
export const ARCH_CEIL_DROP = 0.02;

export interface ArchInfo {
  /** Inside a U-shaped arch z-range. */
  inArch: boolean;
  /** Height of the arch circle at this z (axle height = 0), -Infinity outside. */
  top: number;
  /** Height of the (sloped) arch ceiling where it meets the inner tub wall. */
  innerTop: number;
  /** Tub half width for the arch (inner wall). */
  tub: number;
  /** Signed distance along z from the wheel centre. */
  dz: number;
}

export function archAt(z: number): ArchInfo {
  const dzF = z - WHEEL_Z_FRONT;
  const dzR = z - WHEEL_Z_REAR;
  const make = (dz: number, tub: number): ArchInfo => {
    const top = Math.sqrt(ARCH_RADIUS * ARCH_RADIUS - dz * dz);
    // slope the ceiling down towards the tub so it stays under the hood / deck
    return { inArch: true, top, innerTop: top - ARCH_CEIL_DROP * (top / ARCH_RADIUS), tub, dz };
  };
  if (Math.abs(dzF) < ARCH_RADIUS) return make(dzF, TUB_FRONT);
  if (Math.abs(dzR) < ARCH_RADIUS) return make(dzR, TUB_REAR);
  return { inArch: false, top: -Infinity, innerTop: -Infinity, tub: 0, dz: Math.min(Math.abs(dzF), Math.abs(dzR)) };
}

export function lipBase(z: number): number {
  return LIP_BASE.at(z);
}

/** Paint lip height: the two-tone line, raised to follow the arch circle inside the arches. */
export function lipY(z: number): number {
  const a = archAt(z);
  return Math.max(LIP_BASE.at(z), a.top);
}

/** Recess depth of the black lower body below the lip (0 where the arch defines the paint edge). */
export function lipInset(z: number): number {
  const a = archAt(z);
  const base = LIP_INSET.at(z);
  if (!a.inArch) return base;
  return base * smoothstep(0.0, 0.03, LIP_BASE.at(z) - a.top);
}

/** Paint outer curve at station z (nose-capped, tail edge inset). Cached by z for builders. */
const curveCache = new Map<number, Polyline2>();
export function paintCurve(z: number): Polyline2 {
  let c = curveCache.get(z);
  if (!c) {
    c = outerCurve(sectionAt(z), tailInset(z));
    curveCache.set(z, c);
  }
  return c;
}
export function clearCurveCache(): void {
  curveCache.clear();
}

/** Height of the body's upper surface at lateral offset |x| (shoulder quadrant included). */
export function topY(z: number, x: number): number {
  const c = paintCurve(z);
  const y = c.maxYAtX(Math.abs(x));
  return Number.isFinite(y) ? y : sectionAt(z).yt;
}
