import { Vector3 } from 'three';
import type { TrackFrame } from '../types';

/**
 * Converts a list of centerline frames into:
 *  - render meshes (top drive surface, sides/bottom/caps, optional rails), and
 *  - a closed trimesh for the physics collider (same geometry).
 *
 * The drive surface faces the frame's `up`. For inverted sections the frames' up points
 * downward and the drive surface is the underside of the structure — this is automatic.
 *
 * UVs:
 *  - top:   u = 0 (left edge) .. 1 (right edge), v = arc length in meters.
 *  - sides: u = arc length in meters, v = meters below the drive surface (0..thickness).
 */

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

export interface ColliderMeshData {
  vertices: Float32Array;
  indices: Uint32Array;
}

export interface RibbonBuildOptions {
  width: number | ((s: number) => number);
  /** Slab thickness under the drive surface. Default 1.2. */
  thickness?: number;
  /** Columns across the drive surface (lighting/LOD). Default 4. */
  columns?: number;
  /** Height of collidable side rails (0 = none). */
  rails?: number;
  /** Rail thickness. Default 0.35. */
  railWidth?: number;
}

export interface RibbonGeometryData {
  top: MeshData;
  sides: MeshData;
  rails: MeshData | null;
  collider: ColliderMeshData;
  /** Drive-surface edge polylines (world), for edge lights / trims. */
  leftEdge: Vector3[];
  rightEdge: Vector3[];
  /** Per-frame half widths. */
  halfWidths: number[];
  length: number;
}

class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  uvs: number[] = [];
  indices: number[] = [];
  vertex(p: Vector3, n: Vector3, u: number, v: number): number {
    this.positions.push(p.x, p.y, p.z);
    this.normals.push(n.x, n.y, n.z);
    this.uvs.push(u, v);
    return this.positions.length / 3 - 1;
  }
  tri(a: number, b: number, c: number) {
    this.indices.push(a, b, c);
  }
  build(): MeshData {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      indices: new Uint32Array(this.indices),
    };
  }
}

class ColliderBuilder {
  vertices: number[] = [];
  indices: number[] = [];
  vertex(p: Vector3): number {
    this.vertices.push(p.x, p.y, p.z);
    return this.vertices.length / 3 - 1;
  }
  tri(a: number, b: number, c: number) {
    this.indices.push(a, b, c);
  }
  build(): ColliderMeshData {
    return { vertices: new Float32Array(this.vertices), indices: new Uint32Array(this.indices) };
  }
}

/**
 * Adds a closed slab (top/bottom/left/right/caps) defined by per-frame corner points to the
 * render builder (flat-shaded faces, `topMesh` optional) and the collider builder.
 * Corner arrays: tl/tr = top-left/right, bl/br = bottom-left/right. Winding is CCW from outside.
 */
function addSlab(
  frames: TrackFrame[],
  tl: Vector3[],
  tr: Vector3[],
  bl: Vector3[],
  br: Vector3[],
  sides: MeshBuilder,
  collider: ColliderBuilder,
  top: MeshBuilder | null,
  sideDepth: number,
) {
  const n = frames.length;
  const tmp = new Vector3();

  // ---- collider (shared vertices) ----
  const ctl: number[] = [];
  const ctr: number[] = [];
  const cbl: number[] = [];
  const cbr: number[] = [];
  for (let i = 0; i < n; i++) {
    ctl.push(collider.vertex(tl[i]));
    ctr.push(collider.vertex(tr[i]));
    cbl.push(collider.vertex(bl[i]));
    cbr.push(collider.vertex(br[i]));
  }
  for (let i = 0; i < n - 1; i++) {
    const j = i + 1;
    // top (+up)
    collider.tri(ctl[i], ctr[i], ctr[j]);
    collider.tri(ctl[i], ctr[j], ctl[j]);
    // bottom (-up)
    collider.tri(cbl[i], cbr[j], cbr[i]);
    collider.tri(cbl[i], cbl[j], cbr[j]);
    // left (-right)
    collider.tri(ctl[i], ctl[j], cbl[i]);
    collider.tri(ctl[j], cbl[j], cbl[i]);
    // right (+right)
    collider.tri(ctr[i], cbr[i], ctr[j]);
    collider.tri(ctr[j], cbr[i], cbr[j]);
  }
  // start cap (-forward)
  collider.tri(ctl[0], cbl[0], ctr[0]);
  collider.tri(ctr[0], cbl[0], cbr[0]);
  // end cap (+forward)
  const e = n - 1;
  collider.tri(ctl[e], ctr[e], cbl[e]);
  collider.tri(ctr[e], cbr[e], cbl[e]);

  // ---- render: optional top (handled by caller for multi-column surfaces) ----
  if (top) {
    for (let i = 0; i < n - 1; i++) {
      const j = i + 1;
      const f = frames[i];
      const g = frames[j];
      const a = top.vertex(tl[i], f.up, 0, f.s);
      const b = top.vertex(tr[i], f.up, 1, f.s);
      const c = top.vertex(tr[j], g.up, 1, g.s);
      const d = top.vertex(tl[j], g.up, 0, g.s);
      top.tri(a, b, c);
      top.tri(a, c, d);
    }
  }

  // ---- render: sides, bottom, caps (smooth along the path, flat across faces) ----
  const left: number[][] = [];
  const right: number[][] = [];
  const bottom: number[][] = [];
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    const nl = tmp.copy(f.right).negate().clone();
    left.push([sides.vertex(tl[i], nl, f.s, 0), sides.vertex(bl[i], nl, f.s, sideDepth)]);
    right.push([sides.vertex(tr[i], f.right, f.s, 0), sides.vertex(br[i], f.right, f.s, sideDepth)]);
    const nb = tmp.copy(f.up).negate().clone();
    bottom.push([sides.vertex(bl[i], nb, f.s, 0), sides.vertex(br[i], nb, f.s, 1)]);
  }
  for (let i = 0; i < n - 1; i++) {
    const j = i + 1;
    // left: (tl_i, tl_j, bl_i), (tl_j, bl_j, bl_i)
    sides.tri(left[i][0], left[j][0], left[i][1]);
    sides.tri(left[j][0], left[j][1], left[i][1]);
    // right: (tr_i, br_i, tr_j), (tr_j, br_i, br_j)
    sides.tri(right[i][0], right[i][1], right[j][0]);
    sides.tri(right[j][0], right[i][1], right[j][1]);
    // bottom: (bl_i, br_j, br_i), (bl_i, bl_j, br_j)
    sides.tri(bottom[i][0], bottom[j][1], bottom[i][1]);
    sides.tri(bottom[i][0], bottom[j][0], bottom[j][1]);
  }
  // caps
  const f0 = frames[0];
  const fe = frames[e];
  const n0 = f0.forward.clone().negate();
  const a0 = sides.vertex(tl[0], n0, 0, 0);
  const b0 = sides.vertex(bl[0], n0, 0, sideDepth);
  const c0 = sides.vertex(tr[0], n0, 1, 0);
  const d0 = sides.vertex(br[0], n0, 1, sideDepth);
  sides.tri(a0, b0, c0);
  sides.tri(c0, b0, d0);
  const ne = fe.forward.clone();
  const a1 = sides.vertex(tl[e], ne, 0, 0);
  const b1 = sides.vertex(tr[e], ne, 1, 0);
  const c1 = sides.vertex(bl[e], ne, 0, sideDepth);
  const d1 = sides.vertex(br[e], ne, 1, sideDepth);
  sides.tri(a1, b1, c1);
  sides.tri(b1, d1, c1);
}

export function buildRibbon(frames: TrackFrame[], opts: RibbonBuildOptions): RibbonGeometryData {
  if (frames.length < 2) throw new Error('buildRibbon: need at least 2 frames');
  const thickness = opts.thickness ?? 1.2;
  const columns = Math.max(1, Math.round(opts.columns ?? 4));
  const widthOf = typeof opts.width === 'function' ? opts.width : () => opts.width as number;

  const n = frames.length;
  const halfWidths: number[] = [];
  const tl: Vector3[] = [];
  const tr: Vector3[] = [];
  const bl: Vector3[] = [];
  const br: Vector3[] = [];
  for (const f of frames) {
    const hw = Math.max(0.05, widthOf(f.s) / 2);
    halfWidths.push(hw);
    const l = f.position.clone().addScaledVector(f.right, -hw);
    const r = f.position.clone().addScaledVector(f.right, hw);
    tl.push(l);
    tr.push(r);
    bl.push(l.clone().addScaledVector(f.up, -thickness));
    br.push(r.clone().addScaledVector(f.up, -thickness));
  }

  // ---- top drive surface with columns ----
  const top = new MeshBuilder();
  const rowStart: number[] = [];
  const p = new Vector3();
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    rowStart.push(top.positions.length / 3);
    for (let c = 0; c <= columns; c++) {
      const u = c / columns;
      p.copy(tl[i]).lerp(tr[i], u);
      top.vertex(p, f.up, u, f.s);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let c = 0; c < columns; c++) {
      const a = rowStart[i] + c;
      const b = rowStart[i] + c + 1;
      const cc = rowStart[i + 1] + c + 1;
      const d = rowStart[i + 1] + c;
      top.tri(a, b, cc);
      top.tri(a, cc, d);
    }
  }

  const sides = new MeshBuilder();
  const collider = new ColliderBuilder();
  addSlab(frames, tl, tr, bl, br, sides, collider, null, thickness);

  // ---- rails ----
  let rails: MeshData | null = null;
  const railH = opts.rails ?? 0;
  if (railH > 0) {
    const rw = opts.railWidth ?? 0.35;
    const railMesh = new MeshBuilder();
    for (const side of [-1, 1]) {
      const rtl: Vector3[] = [];
      const rtr: Vector3[] = [];
      const rbl: Vector3[] = [];
      const rbr: Vector3[] = [];
      for (let i = 0; i < n; i++) {
        const f = frames[i];
        const hw = halfWidths[i];
        const inner = side < 0 ? -hw : hw - rw;
        const outer = inner + rw;
        // rail slab: "top" faces up, sits on the drive surface, height railH
        const baseL = f.position.clone().addScaledVector(f.right, inner);
        const baseR = f.position.clone().addScaledVector(f.right, outer);
        rtl.push(baseL.clone().addScaledVector(f.up, railH));
        rtr.push(baseR.clone().addScaledVector(f.up, railH));
        rbl.push(baseL.clone().addScaledVector(f.up, -0.05));
        rbr.push(baseR.clone().addScaledVector(f.up, -0.05));
      }
      addSlab(frames, rtl, rtr, rbl, rbr, railMesh, collider, railMesh, railH);
    }
    rails = railMesh.build();
  }

  return {
    top: top.build(),
    sides: sides.build(),
    rails,
    collider: collider.build(),
    leftEdge: tl.map((v) => v.clone()),
    rightEdge: tr.map((v) => v.clone()),
    halfWidths,
    length: frames[n - 1].s - frames[0].s,
  };
}
