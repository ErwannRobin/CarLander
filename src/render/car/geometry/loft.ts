/**
 * Grid / lathe / ribbon BufferGeometry builders shared by the car parts.
 *
 * All builders output indexed geometry with `position`, `normal` and `uv` attributes so the parts
 * can be merged per material with `mergeGeometries`. Hard edges are produced by duplicating a
 * row/column of vertices (the zero-area quads between duplicates contribute nothing to the
 * area-weighted vertex normals).
 */
import { BufferAttribute, BufferGeometry, Color, Float32BufferAttribute, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface GridOptions {
  /** Wrap the M (ring) direction: the last point connects back to the first. */
  closedRing?: boolean;
  /** Reverse triangle winding (use when the default produces inward normals). */
  flip?: boolean;
}

/**
 * Build a quad grid from N rings of M points (positions packed as xyz, ring-major).
 * Default winding gives outward normals when rings advance along +Z and points run
 * left -> over the top -> right (see body builders).
 */
export function gridGeometry(pos: Float32Array, n: number, m: number, opts: GridOptions = {}): BufferGeometry {
  const { closedRing = false, flip = false } = opts;
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  const uv = new Float32Array(n * m * 2);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const k = (i * m + j) * 2;
      uv[k] = n > 1 ? i / (n - 1) : 0;
      uv[k + 1] = m > 1 ? j / (m - 1) : 0;
    }
  }
  geo.setAttribute('uv', new BufferAttribute(uv, 2));
  const cols = closedRing ? m : m - 1;
  const idx: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < cols; j++) {
      const j1 = (j + 1) % m;
      const a = i * m + j;
      const b = (i + 1) * m + j;
      const c = (i + 1) * m + j1;
      const d = i * m + j1;
      if (!flip) {
        idx.push(a, b, d, b, c, d);
      } else {
        idx.push(a, d, b, b, d, c);
      }
    }
  }
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Pack an array of rings (each a flat xyz array of equal length) and build the grid. */
export function loftRings(rings: ReadonlyArray<ArrayLike<number>>, opts: GridOptions = {}): BufferGeometry {
  const n = rings.length;
  const m = rings[0].length / 3;
  const pos = new Float32Array(n * m * 3);
  for (let i = 0; i < n; i++) {
    const r = rings[i];
    if (r.length !== m * 3) throw new Error(`loftRings: ring ${i} has ${r.length / 3} points, expected ${m}`);
    for (let k = 0; k < m * 3; k++) pos[i * m * 3 + k] = r[k];
  }
  return gridGeometry(pos, n, m, opts);
}

export type Axis = 'x' | 'y' | 'z';

export interface LatheOptions {
  /** Revolution axis (profile height runs along it). Default 'y'. */
  axis?: Axis;
  segments?: number;
  /** Start angle and sweep (radians). A full 2π sweep wraps without a seam. */
  phiStart?: number;
  phiLength?: number;
  flip?: boolean;
}

/**
 * Surface of revolution from a profile of [radius, height] pairs. Consecutive duplicate profile
 * points create a crease. Full revolutions are seamless (wrap-around indexing).
 *
 * Angle convention for axis 'x': phi = 0 points to +Y, increasing towards +Z.
 * For axis 'y': phi = 0 points to +Z, increasing towards +X. For axis 'z': phi = 0 -> +X, towards +Y.
 */
export function latheGeometry(profile: ReadonlyArray<readonly [number, number]>, opts: LatheOptions = {}): BufferGeometry {
  const { axis = 'y', segments = 48, phiStart = 0, phiLength = Math.PI * 2, flip = false } = opts;
  const full = Math.abs(phiLength - Math.PI * 2) < 1e-6;
  const cols = full ? segments : segments + 1;
  const n = cols;
  const m = profile.length;
  // rings = angular columns, ring points = profile points
  const pos = new Float32Array(n * m * 3);
  for (let i = 0; i < n; i++) {
    const phi = phiStart + (phiLength * i) / segments;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    for (let j = 0; j < m; j++) {
      const [r, h] = profile[j];
      const k = (i * m + j) * 3;
      if (axis === 'y') {
        pos[k] = r * s;
        pos[k + 1] = h;
        pos[k + 2] = r * c;
      } else if (axis === 'x') {
        pos[k] = h;
        pos[k + 1] = r * c;
        pos[k + 2] = r * s;
      } else {
        pos[k] = r * c;
        pos[k + 1] = r * s;
        pos[k + 2] = h;
      }
    }
  }
  // Grid: rings advance with phi; within a ring, points follow the profile.
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  const uv = new Float32Array(n * m * 2);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      uv[(i * m + j) * 2] = i / Math.max(1, n - 1);
      uv[(i * m + j) * 2 + 1] = j / Math.max(1, m - 1);
    }
  }
  geo.setAttribute('uv', new BufferAttribute(uv, 2));
  const idx: number[] = [];
  const ringCount = full ? n : n - 1;
  for (let i = 0; i < ringCount; i++) {
    const i1 = (i + 1) % n;
    for (let j = 0; j < m - 1; j++) {
      const a = i * m + j;
      const b = i1 * m + j;
      const c = i1 * m + j + 1;
      const d = i * m + j + 1;
      // Outward normals when the profile is traversed with the outside on its right
      // (radius to the right, height up).
      if (!flip) idx.push(a, b, d, b, c, d);
      else idx.push(a, d, b, b, d, c);
    }
  }
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * A flat ribbon along a 3D polyline: `centers` (xyz flat), `sides` (unit xyz per point, the
 * direction across the ribbon) and a half-width per point. Faces towards `tangent x side`.
 */
export function ribbonGeometry(
  centers: ArrayLike<number>,
  sides: ArrayLike<number>,
  halfWidth: number | ((t: number) => number),
  flip = false,
): BufferGeometry {
  const n = centers.length / 3;
  const pos = new Float32Array(n * 2 * 3);
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    const hw = typeof halfWidth === 'number' ? halfWidth : halfWidth(t);
    for (let s = 0; s < 2; s++) {
      const sign = s === 0 ? -1 : 1;
      for (let a = 0; a < 3; a++) pos[(i * 2 + s) * 3 + a] = centers[i * 3 + a] + sign * hw * sides[i * 3 + a];
    }
  }
  return gridGeometry(pos, n, 2, { flip });
}

/** Give a geometry a uniform vertex color attribute (needed to merge with vertex-colored parts). */
export function paintVertexColor(geo: BufferGeometry, color: Color | string | number): BufferGeometry {
  const c = color instanceof Color ? color : new Color(color);
  const count = geo.getAttribute('position').count;
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new BufferAttribute(arr, 3));
  return geo;
}

/** Vertex colors from a function of the vertex position (local space) and index. */
export function paintVertexColorBy(geo: BufferGeometry, fn: (p: Vector3, out: Color, index?: number) => void): BufferGeometry {
  const pos = geo.getAttribute('position');
  const arr = new Float32Array(pos.count * 3);
  const p = new Vector3();
  const c = new Color();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    fn(p, c, i);
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new Float32BufferAttribute(arr, 3));
  return geo;
}

/** Normalize attribute sets (drop extras, ensure indexed) so a list can be merged. */
export function prepareForMerge(geos: BufferGeometry[], withColor: boolean): BufferGeometry[] {
  return geos.map((g) => {
    let geo = g;
    if (!geo.index) {
      const count = geo.getAttribute('position').count;
      const idx = new Uint32Array(count);
      for (let i = 0; i < count; i++) idx[i] = i;
      geo.setIndex(new BufferAttribute(idx, 1));
    }
    for (const name of Object.keys(geo.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv' && !(withColor && name === 'color')) {
        geo.deleteAttribute(name);
      }
    }
    if (!geo.getAttribute('uv')) {
      geo.setAttribute('uv', new BufferAttribute(new Float32Array(geo.getAttribute('position').count * 2), 2));
    }
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    if (withColor && !geo.getAttribute('color')) paintVertexColor(geo, 0xffffff);
    // morph attributes / groups would break merging
    geo.morphAttributes = {};
    geo.clearGroups();
    return geo;
  });
}

/** Merge a list of part geometries (disposing the sources). */
export function mergeParts(geos: BufferGeometry[], withColor = false): BufferGeometry {
  const prepared = prepareForMerge(geos, withColor);
  const merged = mergeGeometries(prepared, false);
  if (!merged) throw new Error('mergeParts: incompatible geometries');
  for (const g of prepared) g.dispose();
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}

/**
 * Concatenate indexed geometries that share the same attribute layout (position, normal, uv and
 * optionally color). Cheaper than mergeGeometries for many tiny parts. Disposes the inputs.
 */
export function concatGeometries(list: BufferGeometry[]): BufferGeometry {
  const withColor = list.length > 0 && list.every((g) => g.getAttribute('color'));
  let vCount = 0;
  let iCount = 0;
  for (const g of list) {
    vCount += g.getAttribute('position').count;
    iCount += g.getIndex() ? g.getIndex()!.count : g.getAttribute('position').count;
  }
  const pos = new Float32Array(vCount * 3);
  const nrm = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const col = withColor ? new Float32Array(vCount * 3) : null;
  const idx = new Uint32Array(iCount);
  let vo = 0;
  let io = 0;
  for (const g of list) {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const u = g.getAttribute('uv');
    const c = g.getAttribute('color');
    for (let k = 0; k < p.count; k++) {
      pos[(vo + k) * 3] = p.getX(k);
      pos[(vo + k) * 3 + 1] = p.getY(k);
      pos[(vo + k) * 3 + 2] = p.getZ(k);
      if (n) {
        nrm[(vo + k) * 3] = n.getX(k);
        nrm[(vo + k) * 3 + 1] = n.getY(k);
        nrm[(vo + k) * 3 + 2] = n.getZ(k);
      }
      if (u) {
        uv[(vo + k) * 2] = u.getX(k);
        uv[(vo + k) * 2 + 1] = u.getY(k);
      }
      if (col && c) {
        col[(vo + k) * 3] = c.getX(k);
        col[(vo + k) * 3 + 1] = c.getY(k);
        col[(vo + k) * 3 + 2] = c.getZ(k);
      }
    }
    const index = g.getIndex();
    if (index) {
      for (let k = 0; k < index.count; k++) idx[io + k] = index.getX(k) + vo;
      io += index.count;
    } else {
      for (let k = 0; k < p.count; k++) idx[io + k] = k + vo;
      io += p.count;
    }
    vo += p.count;
    g.dispose();
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(pos, 3));
  out.setAttribute('normal', new BufferAttribute(nrm, 3));
  out.setAttribute('uv', new BufferAttribute(uv, 2));
  if (col) out.setAttribute('color', new BufferAttribute(col, 3));
  out.setIndex(new BufferAttribute(idx, 1));
  return out;
}
