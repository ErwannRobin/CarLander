/**
 * Geometry accumulation helpers. Every geometry produced by this module carries the same
 * attribute set — position, normal, uv, uv1 (+ index) — so parts can always be merged per material.
 */
import { BufferAttribute, BufferGeometry, Matrix3, Matrix4, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MeshData } from '@/game/track/Ribbon';

export type Vec3Like = { x: number; y: number; z: number };

const _n = new Vector3();
const _a = new Vector3();
const _b = new Vector3();

export class GeoBuilder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  uv1: number[] = [];
  col: number[] | null = null;
  idx: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  /** Adds a vertex; uv1 defaults to uv (metric UVs). Returns its index. */
  vertex(p: Vec3Like, n: Vec3Like, u: number, v: number, u1 = u, v1 = v): number {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.uv1.push(u1, v1);
    return this.pos.length / 3 - 1;
  }

  /** Enables per-vertex colors (must be called before adding vertices). */
  withColors(): this {
    this.col = [];
    return this;
  }

  color(r: number, g: number, b: number): void {
    this.col?.push(r, g, b);
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** Quad a-b-c-d, counter-clockwise seen from the front. */
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  /**
   * Flat-shaded quad from four corners (CCW from the front). UVs are metric: u along p0->p1,
   * v along p0->p3, offset by (u0, v0).
   */
  flatQuad(p0: Vec3Like, p1: Vec3Like, p2: Vec3Like, p3: Vec3Like, u0 = 0, v0 = 0): void {
    _a.set(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
    _b.set(p3.x - p0.x, p3.y - p0.y, p3.z - p0.z);
    _n.crossVectors(_a, _b).normalize();
    const lu = _a.length();
    const lv = _b.length();
    const n = { x: _n.x, y: _n.y, z: _n.z };
    const a = this.vertex(p0, n, u0, v0);
    const b = this.vertex(p1, n, u0 + lu, v0);
    const c = this.vertex(p2, n, u0 + lu, v0 + lv);
    const d = this.vertex(p3, n, u0, v0 + lv);
    this.quad(a, b, c, d);
  }

  /** Flat triangle (CCW). */
  flatTri(p0: Vec3Like, p1: Vec3Like, p2: Vec3Like): void {
    _a.set(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
    _b.set(p2.x - p0.x, p2.y - p0.y, p2.z - p0.z);
    _n.crossVectors(_a, _b).normalize();
    const n = { x: _n.x, y: _n.y, z: _n.z };
    const lu = _a.length();
    const a = this.vertex(p0, n, 0, 0);
    const b = this.vertex(p1, n, lu, 0);
    const c = this.vertex(p2, n, _b.dot(_a) / Math.max(1e-6, lu), _b.length());
    this.tri(a, b, c);
  }

  /** Appends another (indexed or not) geometry, optionally transformed. Missing uv/uv1 become 0 / uv. */
  append(geo: BufferGeometry, matrix?: Matrix4): void {
    const base = this.vertexCount;
    const p = geo.getAttribute('position');
    const n = geo.getAttribute('normal');
    const uv = geo.getAttribute('uv');
    const uv1 = geo.getAttribute('uv1');
    const nm = matrix ? new Matrix3().getNormalMatrix(matrix) : null;
    const v = new Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      if (matrix) v.applyMatrix4(matrix);
      this.pos.push(v.x, v.y, v.z);
      if (n) {
        v.fromBufferAttribute(n, i);
        if (nm) v.applyMatrix3(nm).normalize();
        this.nor.push(v.x, v.y, v.z);
      } else this.nor.push(0, 1, 0);
      const u = uv ? uv.getX(i) : 0;
      const w = uv ? uv.getY(i) : 0;
      this.uv.push(u, w);
      this.uv1.push(uv1 ? uv1.getX(i) : u, uv1 ? uv1.getY(i) : w);
      if (this.col) this.col.push(1, 1, 1);
    }
    const index = geo.getIndex();
    if (index) for (let i = 0; i < index.count; i++) this.idx.push(base + index.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
  }

  isEmpty(): boolean {
    return this.idx.length === 0;
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('uv1', new BufferAttribute(new Float32Array(this.uv1), 2));
    if (this.col) g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    const count = this.vertexCount;
    g.setIndex(new BufferAttribute(count > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Ribbon MeshData -> BufferGeometry with the module attribute set (uv1 provided or = uv). */
export function meshDataToGeometry(data: MeshData, uv1?: Float32Array): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(data.positions, 3));
  g.setAttribute('normal', new BufferAttribute(data.normals, 3));
  g.setAttribute('uv', new BufferAttribute(data.uvs, 2));
  g.setAttribute('uv1', new BufferAttribute(uv1 ?? data.uvs.slice(), 2));
  g.setIndex(new BufferAttribute(data.indices, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/**
 * Normalizes index type (merging requires all-indexed with a common type) and merges.
 * Returns null for an empty list.
 */
export function mergeAll(geos: BufferGeometry[]): BufferGeometry | null {
  if (geos.length === 0) return null;
  if (geos.length === 1) return geos[0];
  for (const g of geos) {
    const idx = g.getIndex();
    if (idx && !(idx.array instanceof Uint32Array)) g.setIndex(new BufferAttribute(new Uint32Array(idx.array), 1));
  }
  const merged = mergeGeometries(geos, false);
  if (!merged) throw new Error('mergeAll: incompatible geometries');
  for (const g of geos) g.dispose();
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}

/** Groups geometries by key and merges each group. */
export class PartBin<K extends string = string> {
  private parts = new Map<K, BufferGeometry[]>();
  add(key: K, geo: BufferGeometry | null | undefined): void {
    if (!geo) return;
    let list = this.parts.get(key);
    if (!list) {
      list = [];
      this.parts.set(key, list);
    }
    list.push(geo);
  }
  merge(): Map<K, BufferGeometry> {
    const out = new Map<K, BufferGeometry>();
    for (const [k, list] of this.parts) {
      const m = mergeAll(list);
      if (m) out.set(k, m);
    }
    this.parts.clear();
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Prisms / profiles                                                   */
/* ------------------------------------------------------------------ */

export type Vec2 = [number, number];

/**
 * Extrudes a closed CCW polygon (x, z) between two heights with optional per-end scaling
 * (taper). Side faces are flat-shaded; caps optional. Metric UVs (u = perimeter m, v = height m).
 */
export function taperedPrism(
  b: GeoBuilder,
  profile: Vec2[],
  yBottom: number,
  yTop: number,
  scaleBottom: Vec2 = [1, 1],
  scaleTop: Vec2 = [1, 1],
  opts: { capTop?: boolean; capBottom?: boolean; matrix?: Matrix4 } = {},
): void {
  const m = opts.matrix;
  const P = (x: number, y: number, z: number) => {
    const v = new Vector3(x, y, z);
    return m ? v.applyMatrix4(m) : v;
  };
  const n = profile.length;
  let perim = 0;
  for (let i = 0; i < n; i++) {
    const [x0, z0] = profile[i];
    const [x1, z1] = profile[(i + 1) % n];
    const p0b = P(x0 * scaleBottom[0], yBottom, z0 * scaleBottom[1]);
    const p1b = P(x1 * scaleBottom[0], yBottom, z1 * scaleBottom[1]);
    const p1t = P(x1 * scaleTop[0], yTop, z1 * scaleTop[1]);
    const p0t = P(x0 * scaleTop[0], yTop, z0 * scaleTop[1]);
    // CCW polygon seen from +y => outward faces are (p0b, p1b, p1t, p0t) when wound this way
    b.flatQuad(p0b, p1b, p1t, p0t, perim, yBottom);
    perim += Math.hypot(x1 - x0, z1 - z0);
  }
  const cap = (y: number, s: Vec2, up: boolean) => {
    const center = P(0, y, 0);
    const nrm = m ? new Vector3(0, up ? 1 : -1, 0).transformDirection(m) : new Vector3(0, up ? 1 : -1, 0);
    const c = b.vertex(center, nrm, 0, 0);
    const ids = profile.map(([x, z]) => b.vertex(P(x * s[0], y, z * s[1]), nrm, x * s[0], z * s[1]));
    for (let i = 0; i < n; i++) {
      const a = ids[i];
      const d = ids[(i + 1) % n];
      if (up) b.tri(c, a, d);
      else b.tri(c, d, a);
    }
  };
  if (opts.capTop) cap(yTop, scaleTop, true);
  if (opts.capBottom) cap(yBottom, scaleBottom, false);
}

export interface LoftSection {
  y: number;
  /** Scale applied to the profile x / z. */
  sx: number;
  sz: number;
}

/**
 * Optional per-vertex deformation for `loftSections`, applied in output space (after the matrix):
 * `p` is the vertex of profile point `k` on section `section`; mutate it in place.
 */
export type LoftWarp = (p: Vector3, section: number, k: number) => void;

/**
 * Lofts a closed CCW (seen from +y) profile through vertical sections (sorted by y ascending).
 * Shading is smooth along the height (ring normals averaged) and flat across profile edges, which
 * suits sculpted architectural forms (flared pylons, tapered masts). Metric UVs. Normals are
 * derived from the final (transformed + warped) positions, so a `warp` shades correctly.
 */
export function loftSections(b: GeoBuilder, profile: Vec2[], sections: LoftSection[], matrix?: Matrix4, warp?: LoftWarp): void {
  const n = profile.length;
  const m = sections.length;
  if (m < 2) return;
  // final positions per ring
  const rings: Vector3[][] = sections.map((s, i) =>
    profile.map(([x, z], k) => {
      const p = new Vector3(x * s.sx, s.y, z * s.sz);
      if (matrix) p.applyMatrix4(matrix);
      if (warp) warp(p, i, k);
      return p;
    }),
  );
  const e1 = new Vector3();
  const e2 = new Vector3();
  // normal of the quad between rings i and i+1 for profile edge k
  const faceN = (k: number, i: number, out: Vector3) => {
    const a = rings[i][k];
    e1.subVectors(rings[i][(k + 1) % n], a);
    e2.subVectors(rings[i + 1][k], a);
    return out.crossVectors(e1, e2).normalize();
  };
  const nTmp = new Vector3();
  let perim = 0;
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    const edgeLen = Math.hypot(profile[k2][0] - profile[k][0], profile[k2][1] - profile[k][1]);
    const ids: number[] = [];
    let v = 0;
    for (let i = 0; i < m; i++) {
      const nn = new Vector3();
      if (i > 0) nn.add(faceN(k, i - 1, nTmp));
      if (i < m - 1) nn.add(faceN(k, i, nTmp));
      nn.normalize();
      if (i > 0) v += rings[i][k].distanceTo(rings[i - 1][k]);
      ids.push(b.vertex(rings[i][k], nn, perim, v), b.vertex(rings[i][k2], nn, perim + edgeLen * sections[i].sx, v));
    }
    for (let i = 0; i < m - 1; i++) b.quad(ids[i * 2], ids[i * 2 + 1], ids[i * 2 + 3], ids[i * 2 + 2]);
    perim += edgeLen;
  }
}

/** Rectangle (x half-width, z half-depth) with 45° chamfered corners, CCW seen from +y (outward faces). */
export function chamferRect(hx: number, hz: number, c: number): Vec2[] {
  const cc = Math.min(c, hx * 0.45, hz * 0.45);
  if (cc <= 1e-6) {
    return [
      [-hx, hz],
      [hx, hz],
      [hx, -hz],
      [-hx, -hz],
    ];
  }
  return [
    [-hx + cc, hz],
    [hx - cc, hz],
    [hx, hz - cc],
    [hx, -hz + cc],
    [hx - cc, -hz],
    [-hx + cc, -hz],
    [-hx, -hz + cc],
    [-hx, hz - cc],
  ];
}

/**
 * Axis-aligned box with chamfered vertical edges, metric UVs, centered at (cx, cy, cz).
 */
export function chamferBox(
  b: GeoBuilder,
  size: [number, number, number],
  center: [number, number, number] = [0, 0, 0],
  chamfer = 0,
  matrix?: Matrix4,
): void {
  const [sx, sy, sz] = size;
  const local = new Matrix4().makeTranslation(center[0], center[1], center[2]);
  if (matrix) local.premultiply(matrix);
  taperedPrism(b, chamfer > 0 ? chamferRect(sx / 2, sz / 2, chamfer) : chamferRect(sx / 2, sz / 2, 0), -sy / 2, sy / 2, [1, 1], [1, 1], {
    capTop: true,
    capBottom: true,
    matrix: local,
  });
}

/**
 * Sweeps a closed 2D profile (x = outward/right, y = up, CCW when seen looking along +forward)
 * along a polyline with per-point frames. Produces flat-shaded strips per profile edge with
 * u = arc length (m) and v = profile perimeter (m).
 */
export function sweepProfile(
  b: GeoBuilder,
  points: Vec3Like[],
  rights: Vec3Like[],
  ups: Vec3Like[],
  profile: Vec2[],
  opts: { closed?: boolean; caps?: boolean; arc?: number[] } = {},
): void {
  const n = points.length;
  if (n < 2) return;
  const arc = opts.arc ?? cumulativeLength(points);
  const m = profile.length;
  const ring = (i: number, k: number, out: Vector3) => {
    const p = points[i];
    const r = rights[i];
    const u = ups[i];
    const [x, y] = profile[k];
    return out.set(p.x + r.x * x + u.x * y, p.y + r.y * x + u.y * y, p.z + r.z * x + u.z * y);
  };
  const A = new Vector3();
  const B = new Vector3();
  const nrm = new Vector3();
  const fwd = new Vector3();
  let perim = 0;
  const segs = opts.closed ? m : m - 1;
  for (let k = 0; k < segs; k++) {
    const k2 = (k + 1) % m;
    const edgeLen = Math.hypot(profile[k2][0] - profile[k][0], profile[k2][1] - profile[k][1]);
    // outward normal of this profile edge in (right, up) space for a CCW profile
    const ex = profile[k2][0] - profile[k][0];
    const ey = profile[k2][1] - profile[k][1];
    const nx = ey / (edgeLen || 1);
    const ny = -ex / (edgeLen || 1);
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      const r = rights[i];
      const u = ups[i];
      nrm.set(r.x * nx + u.x * ny, r.y * nx + u.y * ny, r.z * nx + u.z * ny).normalize();
      ring(i, k, A);
      ring(i, k2, B);
      ids.push(b.vertex(A, nrm, arc[i], perim), b.vertex(B, nrm, arc[i], perim + edgeLen));
    }
    for (let i = 0; i < n - 1; i++) {
      const a0 = ids[i * 2];
      const a1 = ids[i * 2 + 1];
      const b0 = ids[(i + 1) * 2];
      const b1 = ids[(i + 1) * 2 + 1];
      b.quad(a0, b0, b1, a1);
    }
    perim += edgeLen;
  }
  if (opts.caps) {
    for (const [i, sign] of [
      [0, -1],
      [n - 1, 1],
    ] as const) {
      const j = sign < 0 ? 1 : n - 2;
      fwd.set(points[i].x - points[j].x, points[i].y - points[j].y, points[i].z - points[j].z).normalize();
      const ids = profile.map((_, k) => b.vertex(ring(i, k, A), fwd, profile[k][0], profile[k][1]));
      for (let k = 1; k < m - 1; k++) {
        if (sign > 0) b.tri(ids[0], ids[k + 1], ids[k]);
        else b.tri(ids[0], ids[k], ids[k + 1]);
      }
    }
  }
}

/**
 * Drops points closer than `eps` to the previously kept point. Coincident consecutive points (a
 * closed loop that repeats its first point, a zero-length segment) would otherwise produce zero
 * tangents and NaN normals / bounding spheres in polyline sweeps.
 */
export function dedupePoints<T extends Vec3Like>(points: T[], eps = 1e-4): T[] {
  const out: T[] = [];
  const e2 = eps * eps;
  for (const p of points) {
    const q = out[out.length - 1];
    if (q && (p.x - q.x) ** 2 + (p.y - q.y) ** 2 + (p.z - q.z) ** 2 < e2) continue;
    out.push(p);
  }
  return out;
}

export function cumulativeLength(points: Vec3Like[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const c = points[i];
    out.push(out[i - 1] + Math.hypot(c.x - a.x, c.y - a.y, c.z - a.z));
  }
  return out;
}

/**
 * Rotation-minimizing frames for a polyline (for strips/tubes): tangent-aligned, `up` stays as
 * close as possible to `upHint`. Returns per-point right/up unit vectors.
 */
export function polylineFrames(points: Vec3Like[], upHint: Vec3Like = { x: 0, y: 1, z: 0 }): { rights: Vector3[]; ups: Vector3[] } {
  const n = points.length;
  const rights: Vector3[] = [];
  const ups: Vector3[] = [];
  const t = new Vector3();
  const hint = new Vector3(upHint.x, upHint.y, upHint.z).normalize();
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)];
    const c = points[Math.min(n - 1, i + 1)];
    t.set(c.x - a.x, c.y - a.y, c.z - a.z).normalize();
    // right = t x up ; forward = t (strip local forward); keep up close to hint
    let r = new Vector3().crossVectors(t, hint);
    if (r.lengthSq() < 1e-6) r = new Vector3().crossVectors(t, new Vector3(1, 0, 0));
    r.normalize();
    const u = new Vector3().crossVectors(r, t).normalize();
    rights.push(r);
    ups.push(u);
  }
  return { rights, ups };
}
