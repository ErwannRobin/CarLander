/**
 * Lofted body panels: paint shell, satin-black lower body (sills, intakes, arch tubs/liners,
 * floor), canopy glass + frame band, and the planar Kamm-tail faces.
 */
import { BufferAttribute, BufferGeometry, ShapeUtils, Vector2 } from 'three';
import {
  archAt,
  LOWER_NOSE_Z,
  LOWER_TAIL_Z,
  lipInset,
  lipY,
  noseCap,
  outerCurve,
  paintCurve,
  sectionAt,
  topY,
  WHEEL_Z_FRONT,
  WHEEL_Z_REAR,
  ARCH_RADIUS,
  Z_NOSE,
  Z_TAIL,
  TAIL_EDGE_R,
  lipBase,
} from './bodySurface';
import { loftRings } from './loft';
import { buildStations, clamp, MonotoneSpline, Polyline2, resampleRange, resampleWeighted, smoothstep, spow } from './math';

/* ------------------------------------------------------------------------------------------ */
/* Stations                                                                                    */
/* ------------------------------------------------------------------------------------------ */

function bodySpacing(z: number): number {
  const dzF = Math.abs(z - WHEEL_Z_FRONT);
  const dzR = Math.abs(z - WHEEL_Z_REAR);
  if (z < Z_NOSE + 0.06) return 0.006;
  if (z < Z_NOSE + 0.2) return 0.014;
  if (z > Z_TAIL - TAIL_EDGE_R - 0.01) return 0.006;
  if (z > Z_TAIL - 0.2) return 0.018;
  if (dzF < ARCH_RADIUS + 0.02 || dzR < ARCH_RADIUS + 0.02) return 0.022;
  return 0.04;
}

/** z where the arch circle meets the base lip line (kinks in the paint edge). */
function archLipCrossings(): number[] {
  const out: number[] = [];
  for (const wz of [WHEEL_Z_FRONT, WHEEL_Z_REAR]) {
    for (const side of [-1, 1]) {
      // bisection on f(dz) = sqrt(R^2 - dz^2) - lipBase(wz + dz) along this side
      let lo = 0;
      let hi = ARCH_RADIUS - 1e-6;
      const f = (dz: number) => Math.sqrt(ARCH_RADIUS * ARCH_RADIUS - dz * dz) - lipBase(wz + side * dz);
      if (f(hi) > 0) continue; // circle always above the lip -> no crossing
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        if (f(mid) > 0) lo = mid;
        else hi = mid;
      }
      out.push(wz + side * (lo + hi) / 2);
    }
  }
  return out;
}

/** Station pairs straddling each arch end so vertical arch edges stay crisp. */
function archEdgePairs(): number[] {
  const extra: number[] = [];
  for (const wz of [WHEEL_Z_FRONT, WHEEL_Z_REAR]) {
    for (const side of [-1, 1]) {
      const edge = wz + side * ARCH_RADIUS;
      extra.push(edge - 0.0015, edge + 0.0015);
    }
  }
  return extra;
}

export function paintStations(): number[] {
  return buildStations(Z_NOSE, Z_TAIL, bodySpacing, [...archLipCrossings(), ...archEdgePairs()], 0.001);
}

function lowerStations(): number[] {
  return buildStations(LOWER_NOSE_Z, LOWER_TAIL_Z, bodySpacing, [...archLipCrossings(), ...archEdgePairs()], 0.001);
}

/* ------------------------------------------------------------------------------------------ */
/* Paint shell                                                                                 */
/* ------------------------------------------------------------------------------------------ */

/** Vertices per half ring (lip -> centre top). */
const PAINT_HALF = 56;

/** Right-half paint section points (x,y pairs) from the lip up to the centre top. */
export function paintHalfSection(z: number, count = PAINT_HALF): number[] {
  const curve = paintCurve(z);
  const sLip = curve.firstCrossingY(lipY(z));
  const half: number[] = [];
  resampleWeighted(curve, sLip, curve.length, count, half, 0.035);
  return half;
}

/** Full ring from a right-half section running lip -> top (mirrored for the left side). */
function mirrorRing(half: number[], z: number): Float32Array {
  const n = half.length / 2;
  const ring = new Float32Array((2 * n - 1) * 3);
  let k = 0;
  for (let j = 0; j < n - 1; j++) {
    ring[k++] = -half[j * 2];
    ring[k++] = half[j * 2 + 1];
    ring[k++] = z;
  }
  for (let j = n - 1; j >= 0; j--) {
    ring[k++] = j === n - 1 ? 0 : half[j * 2];
    ring[k++] = half[j * 2 + 1];
    ring[k++] = z;
  }
  return ring;
}

export function buildPaintShell(): BufferGeometry {
  const rings = paintStations().map((z) => mirrorRing(paintHalfSection(z), z));
  return loftRings(rings);
}

/**
 * The shell's last ring (z = Z_TAIL, left lip -> top -> right lip): positions and the shell's own
 * vertex normals there, so the Kamm face can share its outline and continue its shading.
 */
export function paintShellTailRing(shell: BufferGeometry): { pos: Float32Array; nrm: Float32Array } {
  const m = 2 * PAINT_HALF - 1;
  const p = shell.getAttribute('position');
  const n = shell.getAttribute('normal');
  const start = p.count - m;
  const pos = new Float32Array(m * 3);
  const nrm = new Float32Array(m * 3);
  for (let i = 0; i < m; i++) {
    pos[i * 3] = p.getX(start + i);
    pos[i * 3 + 1] = p.getY(start + i);
    pos[i * 3 + 2] = p.getZ(start + i);
    nrm[i * 3] = n.getX(start + i);
    nrm[i * 3 + 1] = n.getY(start + i);
    nrm[i * 3 + 2] = n.getZ(start + i);
  }
  return { pos, nrm };
}

/* ------------------------------------------------------------------------------------------ */
/* Satin-black lower body                                                                      */
/* ------------------------------------------------------------------------------------------ */

const LOW_FLOOR = 7;
const LOW_SEG4 = 12;
const LOW_SEG6 = 3;
const LOW_SEG8 = 9;

/**
 * Right half of the lower-body ring, from the floor centre outwards and up to a hidden flap behind
 * the paint lip. Segment layout (fixed vertex counts so every station has the same topology):
 *   floor | crease | sill or arch tub wall | crease | arch ceiling (liner) | crease | outer recess | flap
 * Outside the arches the tub/ceiling segments degenerate to points on the outer curve.
 */
function lowerHalfSection(z: number): number[] {
  const sec = sectionAt(z, LOWER_NOSE_Z);
  const cap = noseCap(z, LOWER_NOSE_Z);
  const arch = archAt(z);
  const curve = arch.inArch ? paintCurve(z) : outerCurve(sec);
  const yl = lipY(z);
  const inset = lipInset(z) * cap;
  const out: number[] = [];
  const yF = sec.yFloor;

  // floor
  const xFE = arch.inArch ? arch.tub : Math.max(0, sec.wb - 0.03 * cap);
  for (let k = 0; k < LOW_FLOOR; k++) out.push((xFE * k) / (LOW_FLOOR - 1), yF);
  out.push(xFE, yF); // crease

  const sLip = curve.firstCrossingY(yl);
  const tmp: number[] = [];
  let xEnd4: number;
  let yEnd4: number;
  if (arch.inArch) {
    // tub wall
    for (let k = 0; k < LOW_SEG4; k++) out.push(arch.tub, yF + ((arch.innerTop - yF) * k) / (LOW_SEG4 - 1));
    xEnd4 = arch.tub;
    yEnd4 = arch.innerTop;
  } else {
    // chamfer + lower curve up to the junction height
    const yA = Math.min(yl, 0);
    const sA = curve.firstCrossingY(yA);
    const poly = new Polyline2();
    poly.push(xFE, yF);
    poly.push(Math.max(0, sec.wb - inset), sec.ySill);
    const p = { x: 0, y: 0 };
    const steps = 24;
    for (let k = 1; k <= steps; k++) {
      curve.at((sA * k) / steps, p);
      poly.push(Math.max(0, p.x - inset), p.y);
    }
    resampleRange(poly, 0, poly.length, LOW_SEG4, tmp);
    out.push(...tmp);
    xEnd4 = tmp[tmp.length - 2];
    yEnd4 = tmp[tmp.length - 1];
  }
  out.push(xEnd4, yEnd4); // crease

  // arch ceiling (liner) from the tub wall to the outer lip
  if (arch.inArch) {
    const p = { x: 0, y: 0 };
    curve.at(curve.firstCrossingY(arch.top), p);
    const xo = p.x - inset;
    for (let k = 0; k < LOW_SEG6; k++) {
      const t = k / (LOW_SEG6 - 1);
      out.push(arch.tub + (xo - arch.tub) * t, arch.innerTop + (arch.top - arch.innerTop) * t);
    }
    out.push(xo, arch.top); // crease
  } else {
    for (let k = 0; k < LOW_SEG6; k++) out.push(xEnd4, yEnd4);
    out.push(xEnd4, yEnd4);
  }

  // outer recess from the junction up to the lip
  const yStart = arch.inArch ? arch.top : Math.min(yl, 0);
  const sStart = curve.firstCrossingY(yStart);
  tmp.length = 0;
  if (sLip - sStart > 1e-5) {
    resampleRange(curve, sStart, sLip, LOW_SEG8, tmp);
    for (let k = 0; k < tmp.length; k += 2) tmp[k] = Math.max(0, tmp[k] - inset);
  } else {
    const p = { x: 0, y: 0 };
    curve.at(sLip, p);
    for (let k = 0; k < LOW_SEG8; k++) tmp.push(Math.max(0, p.x - inset), p.y);
  }
  out.push(...tmp);

  // hidden flap rising behind the paint so gaps at the step always read as black
  const flapH = 0.022 * smoothstep(0.002, 0.008, inset);
  out.push(tmp[tmp.length - 2], tmp[tmp.length - 1] + flapH);
  return out;
}

/** Full ring ordered right lip -> floor -> left lip (outward normals with default winding). */
function lowerRing(z: number): Float32Array {
  const half = lowerHalfSection(z);
  const n = half.length / 2;
  const ring = new Float32Array((2 * n - 1) * 3);
  let k = 0;
  for (let j = n - 1; j >= 0; j--) {
    ring[k++] = j === 0 ? 0 : half[j * 2];
    ring[k++] = half[j * 2 + 1];
    ring[k++] = z;
  }
  for (let j = 1; j < n; j++) {
    ring[k++] = -half[j * 2];
    ring[k++] = half[j * 2 + 1];
    ring[k++] = z;
  }
  return ring;
}

export function buildLowerBody(): { geometry: BufferGeometry; tailRing: Float32Array } {
  const zs = lowerStations();
  const rings = zs.map(lowerRing);
  return { geometry: loftRings(rings), tailRing: rings[rings.length - 1] };
}

/* ------------------------------------------------------------------------------------------ */
/* Planar faces                                                                                */
/* ------------------------------------------------------------------------------------------ */

export type FaceHole = { x: number; y: number; r: number; seg?: number } | number[];

/**
 * Triangulate a planar outline (x,y pairs, any winding) at constant z with optional holes
 * (circles or x,y polygons), facing +Z (or -Z when `facing` is -1).
 */
export function planarFace(outline: number[], z: number, facing: 1 | -1 = 1, holes: FaceHole[] = []): BufferGeometry {
  const toContour = (pts: number[]): Vector2[] => {
    const c: Vector2[] = [];
    for (let i = 0; i < pts.length; i += 2) {
      const v = new Vector2(pts[i], pts[i + 1]);
      const last = c[c.length - 1];
      if (!last || last.distanceToSquared(v) > 1e-10) c.push(v);
    }
    if (c.length > 2 && c[0].distanceToSquared(c[c.length - 1]) < 1e-10) c.pop();
    return c;
  };
  const contour = toContour(outline);
  if (ShapeUtils.isClockWise(contour)) contour.reverse();
  const holePts: Vector2[][] = holes.map((h) => {
    let pts: Vector2[];
    if (Array.isArray(h)) {
      pts = toContour(h);
    } else {
      const seg = h.seg ?? 40;
      pts = [];
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        pts.push(new Vector2(h.x + Math.cos(a) * h.r, h.y + Math.sin(a) * h.r));
      }
    }
    if (!ShapeUtils.isClockWise(pts)) pts.reverse();
    return pts;
  });
  const faces = ShapeUtils.triangulateShape(contour, holePts);
  const all = contour.concat(...holePts);
  const pos = new Float32Array(all.length * 3);
  const nrm = new Float32Array(all.length * 3);
  const uv = new Float32Array(all.length * 2);
  all.forEach((v, i) => {
    pos[i * 3] = v.x;
    pos[i * 3 + 1] = v.y;
    pos[i * 3 + 2] = z;
    nrm[i * 3 + 2] = facing;
    uv[i * 2] = v.x;
    uv[i * 2 + 1] = v.y;
  });
  const idx: number[] = [];
  // contour is CCW in the XY plane => triangles face +Z
  for (const f of faces) {
    if (facing === 1) idx.push(f[0], f[1], f[2]);
    else idx.push(f[0], f[2], f[1]);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setAttribute('normal', new BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

/** Rear fascia outline from the last lower-body ring (x,y pairs). */
export function lowerTailOutline(tailRing: Float32Array): number[] {
  const pts: number[] = [];
  for (let i = 0; i < tailRing.length; i += 3) pts.push(tailRing[i], tailRing[i + 1]);
  return pts;
}

/* ------------------------------------------------------------------------------------------ */
/* Canopy                                                                                      */
/* ------------------------------------------------------------------------------------------ */

export const CANOPY_Z0 = -0.93;
export const CANOPY_Z1 = 2.06;
/** Base half width of the greenhouse (teardrop in plan, cab-rearward). */
const CANOPY_BW = new MonotoneSpline([
  [CANOPY_Z0, 0.5],
  [-0.7, 0.598],
  [-0.4, 0.668],
  [0.0, 0.7],
  [0.4, 0.688],
  [0.9, 0.604],
  [1.3, 0.5],
  [1.7, 0.39],
  [CANOPY_Z1, 0.285],
]);
/** Dome height above the body centre-line top (windshield -> roof -> fastback). */
const CANOPY_H = new MonotoneSpline([
  [CANOPY_Z0, 0],
  [-0.75, 0.076],
  [-0.5, 0.182],
  [-0.25, 0.288],
  [0.0, 0.362],
  [0.25, 0.398],
  [0.55, 0.382],
  [0.9, 0.3],
  [1.3, 0.196],
  [1.7, 0.104],
  [1.95, 0.04],
  [CANOPY_Z1, 0],
]);
/** Section exponent: higher = flatter roof with tighter side radius. */
const CANOPY_N = new MonotoneSpline([
  [CANOPY_Z0, 4.2],
  [-0.7, 3.5],
  [-0.4, 3.0],
  [0.3, 2.85],
  [1.0, 2.6],
  [CANOPY_Z1, 2.4],
]);
/** Height of the black frame band along the canopy base (m). */
const FRAME_H = 0.024;
const CANOPY_EPS = 0.006;

export interface CanopyPoint {
  x: number;
  y: number;
}

/** Canopy surface point for station z at angle theta (0 = right base, pi/2 = top, pi = left base). */
export function canopyPoint(z: number, theta: number, out: CanopyPoint = { x: 0, y: 0 }): CanopyPoint {
  const bw = CANOPY_BW.at(z);
  const h = CANOPY_H.at(z);
  const n = CANOPY_N.at(z);
  const x = bw * spow(Math.cos(theta), 2 / n);
  const dome = Math.pow(Math.abs(Math.sin(theta)), 2 / n);
  out.x = x;
  out.y = topY(z, x) - CANOPY_EPS + h * dome;
  return out;
}

export function canopyHeight(z: number): number {
  return CANOPY_H.at(z);
}
export function canopyBaseHalfWidth(z: number): number {
  return CANOPY_BW.at(z);
}

/** Angle where the dome rises FRAME_H above its base (frame band edge). */
function frameTheta(z: number): number {
  const h = CANOPY_H.at(z);
  const n = CANOPY_N.at(z);
  if (h <= FRAME_H) return Math.PI / 2;
  return Math.asin(clamp(Math.pow(FRAME_H / h, n / 2), 0, 1));
}

const GLASS_PTS = 60;
const FRAME_PTS = 5;

export function buildCanopy(): { glass: BufferGeometry; frame: BufferGeometry } {
  const zs = buildStations(CANOPY_Z0, CANOPY_Z1, (z) => (z < CANOPY_Z0 + 0.12 || z > CANOPY_Z1 - 0.12 ? 0.012 : 0.032));
  const glassRings: Float32Array[] = [];
  const frameRight: Float32Array[] = [];
  const frameLeft: Float32Array[] = [];
  const p: CanopyPoint = { x: 0, y: 0 };
  for (const z of zs) {
    const tf = frameTheta(z);
    // glass: theta from pi - tf (left) to tf (right)
    const g = new Float32Array(GLASS_PTS * 3);
    for (let j = 0; j < GLASS_PTS; j++) {
      const t = j / (GLASS_PTS - 1);
      const th = Math.PI - tf - (Math.PI - 2 * tf) * t;
      canopyPoint(z, th, p);
      g[j * 3] = p.x;
      g[j * 3 + 1] = p.y;
      g[j * 3 + 2] = z;
    }
    glassRings.push(g);
    const fr = new Float32Array(FRAME_PTS * 3);
    const fl = new Float32Array(FRAME_PTS * 3);
    for (let j = 0; j < FRAME_PTS; j++) {
      const t = j / (FRAME_PTS - 1);
      // right strip: from the frame edge (tf) down to the base (0) -> runs left-to-right outward
      canopyPoint(z, tf * (1 - t), p);
      fr[j * 3] = p.x;
      fr[j * 3 + 1] = p.y;
      fr[j * 3 + 2] = z;
      // left strip: from the base (pi) up to the frame edge (pi - tf)
      canopyPoint(z, Math.PI - tf * (1 - t), p);
      fl[(FRAME_PTS - 1 - j) * 3] = p.x;
      fl[(FRAME_PTS - 1 - j) * 3 + 1] = p.y;
      fl[(FRAME_PTS - 1 - j) * 3 + 2] = z;
    }
    frameRight.push(fr);
    frameLeft.push(fl);
  }
  const glass = loftRings(glassRings);
  const frameGeoR = loftRings(frameRight);
  const frameGeoL = loftRings(frameLeft);
  return { glass, frame: mergeTwo(frameGeoR, frameGeoL) };
}

function mergeTwo(a: BufferGeometry, b: BufferGeometry): BufferGeometry {
  const pa = a.getAttribute('position').array as Float32Array;
  const pb = b.getAttribute('position').array as Float32Array;
  const na = a.getAttribute('normal').array as Float32Array;
  const nb = b.getAttribute('normal').array as Float32Array;
  const ua = a.getAttribute('uv').array as Float32Array;
  const ub = b.getAttribute('uv').array as Float32Array;
  const ia = a.getIndex()!.array;
  const ib = b.getIndex()!.array;
  const ca = pa.length / 3;
  const pos = new Float32Array(pa.length + pb.length);
  pos.set(pa);
  pos.set(pb, pa.length);
  const nrm = new Float32Array(na.length + nb.length);
  nrm.set(na);
  nrm.set(nb, na.length);
  const uv = new Float32Array(ua.length + ub.length);
  uv.set(ua);
  uv.set(ub, ua.length);
  const idx: number[] = Array.from(ia);
  for (let i = 0; i < ib.length; i++) idx.push(ib[i] + ca);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setIndex(idx);
  a.dispose();
  b.dispose();
  return g;
}

