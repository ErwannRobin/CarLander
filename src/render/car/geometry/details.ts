/**
 * Body details: light bars, Kamm-tail composition, rocket nozzles, RCS ports, vacuum skirt,
 * splitter, diffuser fins, sill blades and mirrors. Everything is positioned from vehicleSpec + the body surface
 * queries, so the details stay glued to the sculpted shell when profiles are tuned.
 */
import { BufferAttribute, BufferGeometry, Color, Matrix4, Quaternion, Vector3 } from 'three';
import { NOZZLES, RCS_PORTS, VACUUM_SKIRT } from '@/game/vehicleSpec';
import {
  LOWER_NOSE_Z,
  LOWER_TAIL_Z,
  lipInset,
  lipY,
  outerCurve,
  sectionAt,
  tailInset,
  Z_NOSE,
  Z_TAIL,
} from './bodySurface';
import { concatGeometries, gridGeometry, latheGeometry, paintVertexColor, paintVertexColorBy, ribbonGeometry } from './loft';
import { lowerTailOutline, planarFace } from './bodyParts';
import { clamp, smoothstep } from './math';

type V3 = [number, number, number];
type P2 = [number, number];

/* ------------------------------------------------------------------------------------------ */
/* Helpers                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/**
 * Sweep a closed 2D section (a along `n`, b along `up`) along a 3D path with explicit per-point
 * frames. Ends are capped by collapsing to the section centroid unless `open`.
 */
export function sweep(path: V3[], ns: V3[], ups: V3[], section: (t: number) => P2[], open = false): BufferGeometry {
  const rings: number[][] = [];
  const n = path.length;
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    const P = path[i];
    const N = ns[i];
    const U = ups[i];
    const ring: number[] = [];
    for (const [a, b] of section(t)) ring.push(P[0] + N[0] * a + U[0] * b, P[1] + N[1] * a + U[1] * b, P[2] + N[2] * a + U[2] * b);
    rings.push(ring);
  }
  // Handedness of (n, up, tangent) decides the winding that yields outward normals.
  const T = new Vector3(path[1][0] - path[0][0], path[1][1] - path[0][1], path[1][2] - path[0][2]);
  const handed = new Vector3(...ups[0]).cross(T).dot(new Vector3(...ns[0]));
  if (!open) {
    const cap = (ring: number[]): number[] => {
      const m = ring.length / 3;
      const c = [0, 0, 0];
      for (let k = 0; k < m; k++) for (let a = 0; a < 3; a++) c[a] += ring[k * 3 + a] / m;
      const out: number[] = [];
      for (let k = 0; k < m; k++) out.push(c[0], c[1], c[2]);
      return out;
    };
    rings.unshift(cap(rings[0]));
    rings.push(cap(rings[rings.length - 1]));
  }
  const m = rings[0].length / 3;
  const pos = new Float32Array(rings.length * m * 3);
  rings.forEach((r, i) => pos.set(r, i * m * 3));
  return gridGeometry(pos, rings.length, m, { closedRing: true, flip: handed > 0 });
}

/** Rounded rectangle section centred at (a0, 0): half extents (ha, hb), corner radius r. CCW. */
function roundedRect(a0: number, ha: number, hb: number, r: number, seg = 3): P2[] {
  const pts: P2[] = [];
  const rr = Math.max(1e-4, Math.min(r, ha, hb));
  const corners: [number, number, number][] = [
    [a0 + ha - rr, hb - rr, 0],
    [a0 - ha + rr, hb - rr, Math.PI / 2],
    [a0 - ha + rr, -hb + rr, Math.PI],
    [a0 + ha - rr, -hb + rr, (3 * Math.PI) / 2],
  ];
  for (const [ca, cb, start] of corners) {
    for (let k = 0; k <= seg; k++) {
      const a = start + (k / seg) * (Math.PI / 2);
      pts.push([ca + Math.cos(a) * rr, cb + Math.sin(a) * rr]);
    }
  }
  return pts;
}

/** Replace polygon corners with circular fillets (closed polygon, points as [x, y]). */
function fillet(points: P2[], radius: number | number[], seg = 5): P2[] {
  const out: P2[] = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const r = Array.isArray(radius) ? radius[i] : radius;
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const d0 = [p0[0] - p1[0], p0[1] - p1[1]];
    const d2 = [p2[0] - p1[0], p2[1] - p1[1]];
    const l0 = Math.hypot(d0[0], d0[1]);
    const l2 = Math.hypot(d2[0], d2[1]);
    if (r <= 0 || l0 < 1e-6 || l2 < 1e-6) {
      out.push(p1);
      continue;
    }
    d0[0] /= l0;
    d0[1] /= l0;
    d2[0] /= l2;
    d2[1] /= l2;
    const cos = clamp(d0[0] * d2[0] + d0[1] * d2[1], -1, 1);
    const ang = Math.acos(cos);
    if (ang < 1e-3 || Math.PI - ang < 1e-3) {
      out.push(p1);
      continue;
    }
    const t = Math.min(r / Math.tan(ang / 2), l0 * 0.5, l2 * 0.5);
    const a: P2 = [p1[0] + d0[0] * t, p1[1] + d0[1] * t];
    const b: P2 = [p1[0] + d2[0] * t, p1[1] + d2[1] * t];
    // quadratic Bezier through the corner approximates the fillet well enough at these sizes
    for (let k = 0; k <= seg; k++) {
      const u = k / seg;
      const w0 = (1 - u) * (1 - u);
      const w1 = 2 * u * (1 - u);
      const w2 = u * u;
      out.push([a[0] * w0 + p1[0] * w1 + b[0] * w2, a[1] * w0 + p1[1] * w1 + b[1] * w2]);
    }
  }
  return out;
}

const flat = (pts: P2[]): number[] => pts.flatMap((p) => [p[0], p[1]]);

/* ------------------------------------------------------------------------------------------ */
/* Plan-view contours of the body at a given height                                            */
/* ------------------------------------------------------------------------------------------ */

/** Paint outer half-width at (z, y) (no curve cache: many probe z values). */
function widthAt(z: number, y: number): number {
  const x = outerCurve(sectionAt(z), tailInset(z)).maxXAtY(y);
  return Number.isFinite(x) ? x : 0;
}

/** z on the front surface where the half-width at height y equals x (binary search). */
function frontZ(x: number, y: number): number {
  let lo = Z_NOSE;
  let hi = -1.55;
  for (let k = 0; k < 34; k++) {
    const mid = (lo + hi) / 2;
    if (widthAt(mid, y) < x) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

interface Contour {
  path: V3[];
  ns: V3[];
  ups: V3[];
}

/** Frames for a plan-view polyline (x, z) at height y; normals point away from `interior`. */
function planContour(pts: P2[], y: number, out: number, interior: P2): Contour {
  const path: V3[] = [];
  const ns: V3[] = [];
  const ups: V3[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let tx = b[0] - a[0];
    let tz = b[1] - a[1];
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    let nx = tz;
    let nz = -tx;
    if (nx * (pts[i][0] - interior[0]) + nz * (pts[i][1] - interior[1]) < 0) {
      nx = -nx;
      nz = -nz;
    }
    path.push([pts[i][0] + nx * out, y, pts[i][1] + nz * out]);
    ns.push([nx, 0, nz]);
    ups.push([0, 1, 0]);
  }
  return { path, ns, ups };
}

/** Front contour at height y from -xMax to +xMax (cosine spacing so the wrapped ends get detail). */
function frontContour(y: number, xMax: number, count: number, out = 0): Contour {
  const pts: P2[] = [];
  for (let i = 0; i < count; i++) {
    const x = -xMax * Math.cos((Math.PI * i) / (count - 1));
    pts.push([x, frontZ(Math.abs(x), y)]);
  }
  return planContour(pts, y, out, [0, -1]);
}

/** Rear contour at height y: around the left tail corner, across the Kamm face, around the right. */
function rearContour(y: number, cornerDepth: number, out = 0): Contour {
  const pts: P2[] = [];
  const zc0 = Z_TAIL - cornerDepth;
  const cornerN = 10;
  for (let k = 0; k <= cornerN; k++) {
    const z = zc0 + (Z_TAIL - zc0) * (k / cornerN);
    pts.push([-widthAt(z, y), z]);
  }
  const xf = widthAt(Z_TAIL, y);
  const faceN = 28;
  for (let k = 1; k < faceN; k++) pts.push([-xf + (2 * xf * k) / faceN, Z_TAIL]);
  for (let k = cornerN; k >= 0; k--) {
    const z = zc0 + (Z_TAIL - zc0) * (k / cornerN);
    pts.push([widthAt(z, y), z]);
  }
  return planContour(pts, y, out, [0, 1]);
}

/* ------------------------------------------------------------------------------------------ */
/* Lights                                                                                      */
/* ------------------------------------------------------------------------------------------ */

export const FRONT_BAR_Y = 0.045;
export const REAR_BAR_Y = 0.4;

export interface LightGeometry {
  frontLight: BufferGeometry;
  rearLight: BufferGeometry;
  /** Gloss-black housings behind the lights (glass material). */
  housings: BufferGeometry;
}

export function buildLights(): LightGeometry {
  const housings: BufferGeometry[] = [];
  const front: BufferGeometry[] = [];
  // front full-width bar, thin and slightly proud of the surface, tapering at the wrapped ends
  const fc = frontContour(FRONT_BAR_Y, 0.8, 80);
  front.push(
    sweep(fc.path, fc.ns, fc.ups, (t) => {
      const e = smoothstep(0, 0.05, Math.min(t, 1 - t));
      return roundedRect(-0.0012, 0.0034, 0.0042 * (0.45 + 0.55 * e), 0.0016, 2);
    }),
  );
  const fh = frontContour(FRONT_BAR_Y - 0.001, 0.84, 80);
  housings.push(
    sweep(fh.path, fh.ns, fh.ups, (t) => {
      const e = smoothstep(0, 0.06, Math.min(t, 1 - t));
      return roundedRect(-0.0017, 0.003, 0.0125 * (0.35 + 0.65 * e), 0.003, 2);
    }),
  );
  // slim headlight clusters under the bar, near the corners (two projector strips each)
  for (const side of [-1, 1]) {
    const y = FRONT_BAR_Y - 0.032;
    const pts: P2[] = [];
    for (let k = 0; k <= 14; k++) {
      const x = 0.55 + (0.21 * k) / 14;
      pts.push([side * x, frontZ(x, y)]);
    }
    if (side < 0) pts.reverse();
    const c = planContour(pts, y, 0, [0, -1]);
    housings.push(sweep(c.path, c.ns, c.ups, () => roundedRect(-0.0008, 0.0034, 0.0155, 0.007, 3)));
    const c1 = planContour(pts.slice(1, 14), y + 0.0055, 0.0012, [0, -1]);
    front.push(sweep(c1.path, c1.ns, c1.ups, () => roundedRect(0.0004, 0.0026, 0.0026, 0.0012, 2)));
    const c2 = planContour(pts.slice(3, 12), y - 0.0055, 0.0012, [0, -1]);
    front.push(sweep(c2.path, c2.ns, c2.ups, () => roundedRect(0.0004, 0.0026, 0.0019, 0.0009, 2)));
  }
  // rear full-width bar wrapping around the tail corners
  const rc = rearContour(REAR_BAR_Y, 0.035);
  const rearLight = sweep(rc.path, rc.ns, rc.ups, (t) => {
    const e = smoothstep(0, 0.035, Math.min(t, 1 - t));
    return roundedRect(0.0013, 0.0028, 0.0118 * (0.4 + 0.6 * e), 0.0036, 2);
  });
  const rh = rearContour(REAR_BAR_Y, 0.039);
  housings.push(
    sweep(rh.path, rh.ns, rh.ups, (t) => {
      const e = smoothstep(0, 0.05, Math.min(t, 1 - t));
      return roundedRect(0.0004, 0.0026, 0.039 * (0.3 + 0.7 * e), 0.006, 2);
    }),
  );
  return { frontLight: concatGeometries(front), rearLight, housings: concatGeometries(housings) };
}

/* ------------------------------------------------------------------------------------------ */
/* Kamm tail: paint ducktail band over a full-width recessed dark fascia                       */
/* ------------------------------------------------------------------------------------------ */

/** Paint covers the tail face above this height (matches the two-tone line at the tail). */
const TAIL_PAINT_BOTTOM = 0.2;
/** Fascia half width: covers the inset Kamm outline, stays inside the shell's rounded edge. */
const FASCIA_HALF_W = 0.852;
/** Nozzle housing hole radius in the fascia. */
const NOZZLE_HOLE_R = 0.152;

export interface TailGeometry {
  paint: BufferGeometry;
  black: BufferGeometry;
  /** Gloss-black upper fascia panel (glass material). */
  gloss: BufferGeometry;
}

/** Clip a closed polygon (x,y pairs) to the half plane y >= yc (Sutherland–Hodgman). */
function clipAbove(poly: number[], yc: number): number[] {
  const out: number[] = [];
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const ax = poly[i * 2];
    const ay = poly[i * 2 + 1];
    const j = (i + 1) % n;
    const bx = poly[j * 2];
    const by = poly[j * 2 + 1];
    const aIn = ay >= yc;
    const bIn = by >= yc;
    if (aIn) out.push(ax, ay);
    if (aIn !== bIn) {
      const t = (yc - ay) / (by - ay);
      out.push(ax + (bx - ax) * t, yc);
    }
  }
  return out;
}

/** How far the face normals roll under along the lower (two-tone) edge of the Kamm face (rad). */
const TAIL_LOWER_TILT = 0.2;
/** Distance (m) over which the lower-edge normals blend into the shell normals at the corners. */
const TAIL_CORNER_BLEND = 0.06;
/** Concentric rings of the face grid, and how fast the edge tilt relaxes towards the centre. */
const TAIL_FACE_RINGS = 14;
const TAIL_FACE_FALLOFF = 1.7;

/**
 * The Kamm-tail paint face (ducktail band). The geometry is planar at z = Z_TAIL — it must not grow
 * past VEHICLE.tailZ — but its normal field is "pillowed":
 *  - the outline is the paint shell's last ring (identical vertices: no T-junction slivers),
 *    closed along the two-tone line;
 *  - outline normals are the shell's own end normals (seamless shading over the rounded tail
 *    edge), rolling under along the lower edge;
 *  - towards the middle they relax to +Z along concentric rings shrinking to a central point.
 * The band then catches soft reflection gradients like a gently convex panel instead of reading
 * as one flat, evenly lit plane (it is what the chase camera sees most).
 */
function buildTailPaintFace(ring: { pos: Float32Array; nrm: Float32Array }, z: number): BufferGeometry {
  const bx: number[] = [];
  const by: number[] = [];
  const bn: number[] = []; // boundary normals, xyz
  const m = ring.pos.length / 3;
  for (let i = 0; i < m; i++) {
    bx.push(ring.pos[i * 3]);
    by.push(ring.pos[i * 3 + 1]);
    bn.push(ring.nrm[i * 3], ring.nrm[i * 3 + 1], ring.nrm[i * 3 + 2]);
  }
  // lower edge from the right lip back to the left lip, normals rolled under (-Y), blended into
  // the shell normals near both corners
  const xr = bx[m - 1];
  const yr = by[m - 1];
  const len = Math.hypot(bx[0] - xr, by[0] - yr);
  const segs = Math.max(2, Math.ceil(len / 0.015));
  const lower = new Vector3(0, -Math.sin(TAIL_LOWER_TILT), Math.cos(TAIL_LOWER_TILT));
  const corner = new Vector3();
  const nrm = new Vector3();
  for (let k = 1; k < segs; k++) {
    const t = k / segs;
    bx.push(xr + (bx[0] - xr) * t);
    by.push(yr + (by[0] - yr) * t);
    const c = t < 0.5 ? m - 1 : 0;
    corner.set(ring.nrm[c * 3], ring.nrm[c * 3 + 1], ring.nrm[c * 3 + 2]);
    const w = smoothstep(0, TAIL_CORNER_BLEND, Math.min(t, 1 - t) * len);
    nrm.copy(corner).lerp(lower, w).normalize();
    bn.push(nrm.x, nrm.y, nrm.z);
  }
  const B = bx.length;
  // centre of the concentric rings (the band is star-shaped as seen from here)
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const y of by) {
    yMin = Math.min(yMin, y);
    yMax = Math.max(yMax, y);
  }
  const cx = 0;
  const cy = (yMin + yMax) / 2;

  const K = TAIL_FACE_RINGS;
  const vCount = K * B + 1;
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  for (let k = 0; k < K; k++) {
    const t = k / K; // 0 on the outline .. 1 at the centre
    const tiltScale = Math.pow(1 - t, TAIL_FACE_FALLOFF);
    for (let j = 0; j < B; j++) {
      const vi = k * B + j;
      const x = cx + (bx[j] - cx) * (1 - t);
      const y = cy + (by[j] - cy) * (1 - t);
      pos[vi * 3] = x;
      pos[vi * 3 + 1] = y;
      pos[vi * 3 + 2] = z;
      uv[vi * 2] = x;
      uv[vi * 2 + 1] = y;
      // same tilt direction as the outline normal on this ray, smaller angle inside
      const nx = bn[j * 3];
      const ny = bn[j * 3 + 1];
      const nz = bn[j * 3 + 2];
      const h = Math.hypot(nx, ny);
      const tilt = Math.atan2(h, nz) * tiltScale;
      const s = h > 1e-6 ? Math.sin(tilt) / h : 0;
      nor[vi * 3] = nx * s;
      nor[vi * 3 + 1] = ny * s;
      nor[vi * 3 + 2] = Math.cos(tilt);
    }
  }
  const ci = K * B;
  pos[ci * 3] = cx;
  pos[ci * 3 + 1] = cy;
  pos[ci * 3 + 2] = z;
  nor[ci * 3 + 2] = 1;
  uv[ci * 2] = cx;
  uv[ci * 2 + 1] = cy;

  // The outline runs clockwise seen from +Z (left lip -> over the top -> right lip -> lower edge);
  // check the signed area anyway and pick the winding that faces +Z.
  let area2 = 0;
  for (let j = 0; j < B; j++) {
    const j1 = (j + 1) % B;
    area2 += bx[j] * by[j1] - bx[j1] * by[j];
  }
  const cw = area2 < 0;
  const idx: number[] = [];
  const tri = (a: number, b: number, c: number) => (cw ? idx.push(a, c, b) : idx.push(a, b, c));
  for (let k = 0; k < K - 1; k++) {
    for (let j = 0; j < B; j++) {
      const j1 = (j + 1) % B;
      const a = k * B + j;
      const b = k * B + j1;
      const c = (k + 1) * B + j1;
      const d = (k + 1) * B + j;
      tri(a, b, c);
      tri(a, c, d);
    }
  }
  for (let j = 0; j < B; j++) tri((K - 1) * B + j, (K - 1) * B + ((j + 1) % B), ci);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setAttribute('normal', new BufferAttribute(nor, 3));
  geo.setAttribute('uv', new BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

export function buildTail(lowerTailRing: Float32Array, paintRing: { pos: Float32Array; nrm: Float32Array }): TailGeometry {
  // paint: the Kamm face above the light band (ducktail band)
  const paint = buildTailPaintFace(paintRing, Z_TAIL);

  // dark fascia, recessed 2.5 cm: lower-body tail ring + a full-width panel up behind the band
  const ring = lowerTailOutline(lowerTailRing); // right flap -> floor -> left flap
  const n = ring.length / 2;
  const yFlap = Math.min(ring[1], ring[n * 2 - 1]);
  const top = TAIL_PAINT_BOTTOM + 0.008;
  const blackOutline = [...ring, -FASCIA_HALF_W, yFlap, -FASCIA_HALF_W, top, FASCIA_HALF_W, top, FASCIA_HALF_W, yFlap];
  const holes = NOZZLES.map((nz) => ({ x: nz.position[0], y: nz.position[1], r: NOZZLE_HOLE_R, seg: 48 }));
  const blackFace = planarFace(blackOutline, LOWER_TAIL_Z, 1, holes);

  // short return under the paint band so the 2.5 cm step reads as a crisp shadow line
  const centers: number[] = [];
  const sides: number[] = [];
  const zMid = (Z_TAIL + LOWER_TAIL_Z) / 2;
  const steps = 24;
  for (let k = 0; k <= steps; k++) {
    centers.push(-FASCIA_HALF_W + (2 * FASCIA_HALF_W * k) / steps, TAIL_PAINT_BOTTOM + 0.0005, zMid);
    sides.push(0, 0, 1);
  }
  const lip = ribbonGeometry(centers, sides, (Z_TAIL - LOWER_TAIL_Z) / 2 + 0.001);

  // gloss upper panel between the light band and the nozzles (layering on the fascia)
  const panel = fillet(
    [
      [-0.8, 0.152],
      [0.8, 0.152],
      [0.8, TAIL_PAINT_BOTTOM + 0.004],
      [-0.8, TAIL_PAINT_BOTTOM + 0.004],
    ],
    [0.02, 0.02, 0, 0],
    5,
  );
  // 4 mm proud of the fascia: enough depth precision to never z-fight at game camera distances
  const gloss = planarFace(flat(panel), LOWER_TAIL_Z + 0.004, 1);
  return { paint, black: concatGeometries([blackFace, lip]), gloss };
}

/** Titanium bezels around the nozzle housings, flush on the fascia. */
export function buildNozzleBezels(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (const nz of NOZZLES) {
    const g = latheGeometry(
      [
        [NOZZLE_HOLE_R + 0.016, -0.001],
        [NOZZLE_HOLE_R + 0.016, 0.0015],
        [NOZZLE_HOLE_R + 0.012, 0.004],
        [NOZZLE_HOLE_R + 0.003, 0.004],
        [NOZZLE_HOLE_R - 0.0005, 0.001],
        [NOZZLE_HOLE_R - 0.0005, -0.006],
      ],
      { axis: 'z', segments: 64 },
    );
    g.translate(nz.position[0], nz.position[1], LOWER_TAIL_Z);
    parts.push(paintVertexColor(g, '#d7dbe0'));
  }
  return concatGeometries(parts);
}

/* ------------------------------------------------------------------------------------------ */
/* Rocket nozzles                                                                              */
/* ------------------------------------------------------------------------------------------ */

const NOZZLE_DEPTH = 0.2;
const THROAT_R = 0.058;

function bellRadius(h: number, exitR: number): number {
  const t = clamp((h + NOZZLE_DEPTH) / NOZZLE_DEPTH, 0, 1);
  return THROAT_R + (exitR - THROAT_R) * Math.pow(t, 0.62);
}

const HEAT = [
  { t: 0.0, c: new Color('#dccb9e') }, // straw at the lip
  { t: 0.1, c: new Color('#b48d5a') }, // gold / bronze
  { t: 0.24, c: new Color('#6c4e72') }, // purple
  { t: 0.42, c: new Color('#36497a') }, // blue
  { t: 0.68, c: new Color('#20252f') }, // heat-soaked
  { t: 1.0, c: new Color('#15181d') }, // dark throat
];
function heatColor(t: number, out: Color): Color {
  for (let i = 1; i < HEAT.length; i++) {
    if (t <= HEAT[i].t) {
      const k = (t - HEAT[i - 1].t) / (HEAT[i].t - HEAT[i - 1].t);
      return out.copy(HEAT[i - 1].c).lerp(HEAT[i].c, k);
    }
  }
  return out.copy(HEAT[HEAT.length - 1].c);
}

export interface NozzleGeometry {
  /** Heat-tinted titanium bells (vertex coloured). */
  bells: BufferGeometry;
  /** Additive emissive throat glow (vertex coloured gradient). */
  throat: BufferGeometry;
  /** Black housing tubes behind the fascia holes. */
  housings: BufferGeometry;
}

export function buildNozzles(): NozzleGeometry {
  const bells: BufferGeometry[] = [];
  const throats: BufferGeometry[] = [];
  const housings: BufferGeometry[] = [];
  const titanium = new Color('#c9ced4');
  for (const nz of NOZZLES) {
    const [x0, y0, z0] = nz.position;
    const R = nz.radius;
    const prof: P2[] = [];
    // outer skin (towards the exit), lip, then the inner bell back to the throat
    prof.push([R + 0.014, -0.15], [R + 0.015, -0.03], [R + 0.012, -0.006], [R + 0.006, 0.0015], [R - 0.001, 0.0015]);
    for (let k = 0; k <= 16; k++) {
      const h = -0.004 - (NOZZLE_DEPTH - 0.004) * (k / 16);
      prof.push([bellRadius(h, R) - 0.002, h]);
    }
    const bell = latheGeometry(prof, { axis: 'z', segments: 56 });
    paintVertexColorBy(bell, (p, c) => {
      const h = p.z;
      const r = Math.hypot(p.x, p.y);
      const inner = r < bellRadius(h, R) + 0.004 && h < -0.002;
      if (inner) heatColor(clamp(-h / NOZZLE_DEPTH, 0, 1), c);
      else c.copy(titanium).lerp(HEAT[1].c, smoothstep(-0.06, 0.0, h) * 0.55);
    });
    bell.translate(x0, y0, z0);
    bells.push(bell);

    // throat closure + central pintle (reads as a rocket engine, hides the body interior)
    const plug = latheGeometry(
      [
        [THROAT_R + 0.002, -NOZZLE_DEPTH - 0.002],
        [0.046, -NOZZLE_DEPTH - 0.002],
        [0.041, -NOZZLE_DEPTH + 0.006],
        [0.024, -0.152],
        [0.009, -0.132],
        [0.0, -0.128],
      ],
      { axis: 'z', segments: 40 },
    );
    paintVertexColorBy(plug, (p, c) => {
      const t = clamp((p.z + NOZZLE_DEPTH) / 0.07, 0, 1);
      c.set('#14171c').lerp(HEAT[3].c, 0.15 + 0.25 * t);
    });
    plug.translate(x0, y0, z0);
    bells.push(plug);

    // throat glow: lines the inner bell from the throat outwards + a white-hot core disc
    const tp: P2[] = [];
    for (let k = 0; k <= 10; k++) {
      const h = -0.07 - (NOZZLE_DEPTH - 0.072) * (k / 10);
      tp.push([bellRadius(h, R) - 0.0045, h]);
    }
    const throat = latheGeometry(tp, { axis: 'z', segments: 40 });
    // glow skin over the pintle (white-hot during full thrust)
    const pin = latheGeometry(
      [
        [0.0435, -NOZZLE_DEPTH + 0.007],
        [0.0262, -0.151],
        [0.0105, -0.1305],
        [0.0, -0.1265],
      ],
      { axis: 'z', segments: 32 },
    );
    const hot = new Color('#fff1d6');
    const orange = new Color('#ff7a1c');
    paintVertexColorBy(throat, (p, c) => {
      const t = clamp((p.z + NOZZLE_DEPTH) / (NOZZLE_DEPTH - 0.07), 0, 1); // 0 throat .. 1 outer end
      c.copy(hot).lerp(orange, smoothstep(0.0, 0.55, t)).multiplyScalar(1 - smoothstep(0.35, 1.0, t));
    });
    paintVertexColorBy(pin, (p, c) => {
      const t = clamp((p.z + NOZZLE_DEPTH) / 0.075, 0, 1);
      c.copy(hot).lerp(orange, 0.25 + 0.5 * t).multiplyScalar(0.85 - 0.35 * t);
    });
    throat.translate(x0, y0, z0);
    pin.translate(x0, y0, z0);
    throats.push(throat, pin);

    // housing tube (inner wall facing the axis) + back wall
    const hp: P2[] = [
      [NOZZLE_HOLE_R, LOWER_TAIL_Z - z0 + 0.004],
      [NOZZLE_HOLE_R, -0.16],
      [R + 0.012, -0.16],
    ];
    const housing = latheGeometry(hp, { axis: 'z', segments: 48 });
    housing.translate(x0, y0, z0);
    housings.push(housing);
  }
  return { bells: concatGeometries(bells), throat: concatGeometries(throats), housings: concatGeometries(housings) };
}

/* ------------------------------------------------------------------------------------------ */
/* RCS ports                                                                                   */
/* ------------------------------------------------------------------------------------------ */

export interface RcsPortVisual {
  /** Vent centre on the body surface (chassis space). */
  position: V3;
  /** Nominal jet direction from RCS_PORTS. */
  dir: V3;
  /** Outward surface normal at the vent (the vent geometry is aligned to it). */
  normal: V3;
}

let rcsSurface: ReadonlyArray<RcsPortVisual> | null = null;

/** Top surface height at (x, z) without polluting the curve cache. */
function topAt(z: number, x: number): number {
  const y = outerCurve(sectionAt(z), tailInset(z)).maxYAtX(Math.abs(x));
  return Number.isFinite(y) ? y : sectionAt(z).yt;
}

/**
 * Visual RCS port positions snapped onto the body surface (same order as RCS_PORTS): up ports onto
 * the hood/deck, down ports onto the floor, side ports onto the flank. VFX can use these to spawn
 * jets right at the visible vents.
 */
export function rcsPortSurface(): ReadonlyArray<RcsPortVisual> {
  if (rcsSurface) return rcsSurface;
  const e = 0.01;
  rcsSurface = RCS_PORTS.map((p) => {
    const [x, y, z] = p.position;
    const [dx, dy] = p.dir;
    let pos: V3;
    const n = new Vector3();
    if (dy > 0.5) {
      pos = [x, topAt(z, x), z];
      // finite-difference normal of the height field y(x, z)
      const ddx = (topAt(z, x + e) - topAt(z, x - e)) / (2 * e);
      const ddz = (topAt(z + e, x) - topAt(z - e, x)) / (2 * e);
      n.set(-ddx, 1, -ddz).normalize();
    } else if (dy < -0.5) {
      pos = [x, sectionAt(z).yFloor, z];
      n.set(0, -1, 0);
    } else {
      const below = y < lipY(z);
      const inset = below ? lipInset(z) : 0;
      const w = (zz: number, yy: number) => Math.max(0, widthAt(zz, yy) - inset);
      const s = Math.sign(dx);
      pos = [s * w(z, y), y, z];
      // normal of the flank x = w(y, z): (1, -dw/dy, -dw/dz) mirrored to the side
      const dwdy = (w(z, y + e) - w(z, y - e)) / (2 * e);
      const dwdz = (w(z + e, y) - w(z - e, y)) / (2 * e);
      n.set(s, -dwdy, -dwdz).normalize();
    }
    return { position: pos, dir: [p.dir[0], p.dir[1], p.dir[2]] as V3, normal: [n.x, n.y, n.z] as V3 };
  });
  return rcsSurface;
}

export interface RcsGeometry {
  rims: BufferGeometry;
  vents: BufferGeometry;
}

export function buildRcsPorts(): RcsGeometry {
  const rims: BufferGeometry[] = [];
  const vents: BufferGeometry[] = [];
  const m = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const n = new Vector3();
  for (const port of rcsPortSurface()) {
    const rim = latheGeometry(
      [
        [0.02, -0.006],
        [0.02, 0.0005],
        [0.0165, 0.0025],
        [0.0118, 0.0018],
        [0.011, -0.004],
      ],
      { axis: 'y', segments: 24 },
    );
    const vent = latheGeometry(
      [
        [0.0115, -0.0025],
        [0.0, -0.0025],
      ],
      { axis: 'y', segments: 24 },
    );
    n.set(...port.normal);
    m.makeRotationFromQuaternion(q.setFromUnitVectors(up, n));
    for (const g of [rim, vent]) {
      g.applyMatrix4(m);
      g.translate(port.position[0] - n.x * 0.0015, port.position[1] - n.y * 0.0015, port.position[2] - n.z * 0.0015);
    }
    rims.push(paintVertexColor(rim, '#ffffff'));
    vents.push(vent);
  }
  return { rims: concatGeometries(rims), vents: concatGeometries(vents) };
}

/* ------------------------------------------------------------------------------------------ */
/* Vacuum skirt                                                                                */
/* ------------------------------------------------------------------------------------------ */

const SKIRT_Y = VACUUM_SKIRT.y - 0.003;
const SKIRT_L = VACUUM_SKIRT.halfLength;
const SKIRT_W = VACUUM_SKIRT.halfWidth;

/** Stepped plan outline (x, z): narrow between the front wheels, full width mid-car, tub width at the rear. */
function skirtOutline(inset: number): P2[] {
  const fw = 0.48 - inset;
  const rw = 0.6 - inset;
  const mw = SKIRT_W - inset;
  const L = SKIRT_L - inset;
  const half: P2[] = [
    [fw, -L],
    [fw, -0.98 + inset * 0.5],
    [mw, -0.86 + inset],
    [mw, 0.86 - inset],
    [rw, 0.98 - inset * 0.5],
    [rw, L],
  ];
  const pts: P2[] = [...half, ...half.slice().reverse().map(([x, z]) => [-x, z] as P2)];
  return fillet(pts, [0.05, 0.06, 0.06, 0.06, 0.06, 0.05, 0.05, 0.06, 0.06, 0.06, 0.06, 0.05], 5);
}

export interface SkirtGeometry {
  plate: BufferGeometry;
  grille: BufferGeometry;
}

export function buildSkirt(): SkirtGeometry {
  // plate: build in XY (x, z) then rotate so it lies in XZ facing -Y
  const plate = planarFace(flat(skirtOutline(0)), 0, 1);
  plate.rotateX(Math.PI / 2);
  plate.translate(0, SKIRT_Y, 0);
  // emissive perimeter loop
  const loop = skirtOutline(0.055);
  loop.push(loop[0]);
  const y = SKIRT_Y - 0.0015;
  const parts: BufferGeometry[] = [];
  const loopRibbon = (pts: P2[], hw: number) => {
    const c: number[] = [];
    const s: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      let tx = b[0] - a[0];
      let tz = b[1] - a[1];
      const l = Math.hypot(tx, tz) || 1;
      tx /= l;
      tz /= l;
      c.push(pts[i][0], y, pts[i][1]);
      s.push(-tz, 0, tx); // tangent x side = -Y (faces down)
    }
    return ribbonGeometry(c, s, hw);
  };
  parts.push(loopRibbon(loop, 0.007));
  // transverse slats mid-car
  for (let k = -3; k <= 3; k++) {
    const z = k * 0.22;
    parts.push(loopRibbon([[-0.58, z], [0.58, z]], 0.006));
  }
  return { plate, grille: concatGeometries(parts) };
}

/* ------------------------------------------------------------------------------------------ */
/* Splitter + diffuser fins                                                                    */
/* ------------------------------------------------------------------------------------------ */

export function buildAero(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  // splitter blade following the lower nose plan, protruding to the nose line
  const zBack = -1.84;
  const pts: P2[] = [];
  const N = 40;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const z = LOWER_NOSE_Z + (zBack - LOWER_NOSE_Z) * (1 - Math.cos((t * Math.PI) / 2));
    const sec = sectionAt(z, LOWER_NOSE_Z);
    pts.push([sec.wb, z]);
  }
  // right half from the tip back, then mirrored
  const outline: P2[] = [];
  for (let i = N; i >= 0; i--) outline.push([-pts[i][0], pts[i][1]]);
  for (let i = 1; i <= N; i++) outline.push(pts[i]);
  // offset forward/outward (plan normal) so the blade tip lands on VEHICLE.noseZ
  const off = planContour(outline, 0, LOWER_NOSE_Z - Z_NOSE, [0, -1]).path.map((p) => [p[0], p[2]] as P2);
  const yTop = -0.188;
  const yBot = -0.2;
  const shape = [...off, [off[off.length - 1][0], zBack + 0.02] as P2, [off[0][0], zBack + 0.02] as P2];
  const top = planarFace(flat(shape), 0, -1); // after rotateX(+PI/2): -Z -> +Y
  top.rotateX(Math.PI / 2);
  top.translate(0, yTop, 0);
  const bot = planarFace(flat(shape), 0, 1);
  bot.rotateX(Math.PI / 2);
  bot.translate(0, yBot, 0);
  parts.push(top, bot);
  const ec: number[] = [];
  const es: number[] = [];
  for (const p of off) {
    ec.push(p[0], (yTop + yBot) / 2, p[1]);
    es.push(0, 1, 0);
  }
  // edge band: traverse right-to-left so tangent x up faces forward
  const edge = ribbonGeometry(ec, es, (yTop - yBot) / 2, true);
  parts.push(edge);

  // diffuser fins under the rear
  for (const fx of [-0.6, -0.13, 0.13, 0.6]) {
    const prof: number[] = [];
    const zs: number[] = [];
    for (let k = 0; k <= 12; k++) zs.push(1.74 + ((LOWER_TAIL_Z - 0.004 - 1.74) * k) / 12);
    const yb = -0.226;
    prof.push(zs[0], yb, zs[zs.length - 1], yb);
    for (let k = zs.length - 1; k >= 0; k--) prof.push(zs[k], Math.max(yb + 0.002, sectionAt(zs[k]).yFloor + 0.008));
    for (const side of [-1, 1] as const) {
      const f = planarFace(prof, 0, side === 1 ? 1 : -1);
      f.rotateY(-Math.PI / 2); // (x2d=z, y) -> (0, y, z); +Z normal -> -X
      f.translate(fx + side * -0.005, 0, 0);
      parts.push(f);
    }
    const bc: number[] = [];
    const bs: number[] = [];
    for (const z of zs) {
      bc.push(fx, yb, z);
      bs.push(1, 0, 0);
    }
    parts.push(ribbonGeometry(bc, bs, 0.005, true));
  }
  return concatGeometries(parts);
}

/* ------------------------------------------------------------------------------------------ */
/* Sill blades + intake vane                                                                   */
/* ------------------------------------------------------------------------------------------ */

/** Recessed lower-body half-width at (z, y) near the nose. */
function lowerWidthAt(z: number, y: number): number {
  const x = outerCurve(sectionAt(z, LOWER_NOSE_Z)).maxXAtY(y);
  return Number.isFinite(x) ? Math.max(0, x - lipInset(z)) : 0;
}

/** Slim titanium vane across the front intake, following the lower nose in plan. */
export function buildIntakeVane(): BufferGeometry {
  const y = -0.128;
  const xMax = 0.7;
  const pts: P2[] = [];
  const count = 48;
  for (let i = 0; i < count; i++) {
    const x = -xMax * Math.cos((Math.PI * i) / (count - 1));
    let lo = LOWER_NOSE_Z;
    let hi = -1.6;
    for (let k = 0; k < 30; k++) {
      const mid = (lo + hi) / 2;
      if (lowerWidthAt(mid, y) < Math.abs(x)) lo = mid;
      else hi = mid;
    }
    pts.push([x, (lo + hi) / 2]);
  }
  const c = planContour(pts, y, 0, [0, -1]);
  const vane = sweep(c.path, c.ns, c.ups, (t) => {
    const e = smoothstep(0, 0.08, Math.min(t, 1 - t));
    return roundedRect(0.004 * e - 0.002, 0.009 * e + 0.002, 0.0032, 0.0016, 2);
  });
  return paintVertexColorBy(vane, (_, col) => col.set('#b4bbc3'));
}

/** Slim titanium blade along each sill, between the arches, on the recessed black surface. */
export function buildSillBlades(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const z0 = -0.86;
  const z1 = 0.84;
  const y = -0.155;
  const n = 36;
  for (const side of [-1, 1]) {
    const path: V3[] = [];
    const ns: V3[] = [];
    const ups: V3[] = [];
    for (let k = 0; k <= n; k++) {
      const z = z0 + ((z1 - z0) * k) / n;
      const sec = sectionAt(z);
      const x = outerCurve(sec).maxXAtY(y) - lipInset(z);
      // surface normal of the tucked-under sill: tilt the blade's face slightly downwards
      path.push([side * x, y, z]);
      ns.push([side * 0.94, -0.34, 0]);
      ups.push([side * 0.34, 0.94, 0]);
    }
    parts.push(
      sweep(path, ns, ups, (t) => {
        const e = smoothstep(0, 0.06, Math.min(t, 1 - t));
        return roundedRect(0.0015, 0.003, 0.0055 * (0.25 + 0.75 * e), 0.0025, 2);
      }),
    );
  }
  return paintVertexColorBy(concatGeometries(parts), (_, c) => c.set('#c3c9d0'));
}

/* ------------------------------------------------------------------------------------------ */
/* Mirrors                                                                                     */
/* ------------------------------------------------------------------------------------------ */

export interface MirrorGeometry {
  pods: BufferGeometry;
  glass: BufferGeometry;
  stalks: BufferGeometry;
}

export function buildMirrors(): MirrorGeometry {
  const pods: BufferGeometry[] = [];
  const glass: BufferGeometry[] = [];
  const stalks: BufferGeometry[] = [];
  const zF = -0.66;
  const zB = -0.572;
  const hx = 0.062;
  const hy = 0.027;
  const cy = 0.44;
  for (const side of [-1, 1]) {
    const cx = side * 0.995;
    const rings: number[][] = [];
    const steps = 14;
    const seg = 28;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const z = zF + (zB - zF) * t;
      // rounded nose, full section at the back
      const s = Math.sqrt(Math.max(0, 1 - Math.pow(1 - t, 2.2)));
      const ring: number[] = [];
      for (let j = 0; j < seg; j++) {
        const a = (j / seg) * Math.PI * 2;
        const c = Math.cos(a);
        const sn = Math.sin(a);
        const ex = Math.sign(c) * Math.pow(Math.abs(c), 0.7);
        const ey = Math.sign(sn) * Math.pow(Math.abs(sn), 0.7);
        // slight wedge: lower edge tucks in towards the front
        ring.push(cx + ex * hx * s, cy + ey * hy * s * (ey < 0 ? 0.85 + 0.15 * t : 1), z);
      }
      rings.push(ring);
    }
    // rings advance +Z, points CCW seen from +Z: default winding gives outward normals
    const pod = gridGeometry(Float32Array.from(rings.flat()), rings.length, seg, { closedRing: true, flip: true });
    pods.push(pod);
    const face: number[] = [];
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      face.push(cx + Math.sign(c) * Math.pow(Math.abs(c), 0.7) * hx * 0.93, cy + Math.sign(sn) * Math.pow(Math.abs(sn), 0.7) * hy * 0.9);
    }
    glass.push(planarFace(face, zB + 0.0008, 1));
    // aero stalk from the shoulder to the inner face of the pod
    const zs = -0.6;
    const rootY = 0.375;
    const root: V3 = [side * (widthAt(zs + 0.07, rootY) - 0.01), rootY, zs + 0.07];
    const tip: V3 = [side * 0.948, cy - 0.006, zs];
    const path: V3[] = [];
    const ns: V3[] = [];
    const ups: V3[] = [];
    const T = new Vector3(tip[0] - root[0], tip[1] - root[1], tip[2] - root[2]).normalize();
    const fwd = new Vector3(0, 0, -1);
    const nrm = fwd.clone().sub(T.clone().multiplyScalar(T.dot(fwd))).normalize();
    const up = new Vector3().crossVectors(T, nrm).normalize();
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      path.push([root[0] + (tip[0] - root[0]) * t, root[1] + (tip[1] - root[1]) * t, root[2] + (tip[2] - root[2]) * t]);
      ns.push([nrm.x, nrm.y, nrm.z]);
      ups.push([up.x, up.y, up.z]);
    }
    stalks.push(
      sweep(path, ns, ups, (t) => {
        const chord = 0.036 - 0.008 * t;
        const th = 0.0055;
        const pts: P2[] = [];
        for (let j = 0; j < 16; j++) {
          const a = (j / 16) * Math.PI * 2;
          pts.push([Math.cos(a) * chord * 0.5, Math.sin(a) * th]);
        }
        return pts;
      }),
    );
  }
  return { pods: concatGeometries(pods), glass: concatGeometries(glass), stalks: concatGeometries(stalks) };
}
