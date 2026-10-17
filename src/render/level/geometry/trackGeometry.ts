/**
 * Render geometry for track pieces (ribbons and boxes), emitted into a PartBin keyed by material.
 *
 * Ribbons go through buildRibbon() with exactly the options physics uses (width, thickness,
 * rails), so the drive surface and rails are the collider surfaces. The slab sides are rebuilt
 * here from the same corner points (leftEdge/rightEdge - up * thickness) to get metric UVs and a
 * small bottom chamfer; only that chamfer (15 cm, underside) deviates from the collider.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { BoxPieceDef, EdgeLight, RibbonPieceDef, TrackFrame, TrackStyle } from '@/game/types';
import { buildRibbon } from '@/game/track/Ribbon';
import { quatFromRotationDeg } from '@/game/track/zones';
import type { LedColor } from '../materials';
import { getFieldLayoutTextures, getLayoutTextures } from '../textures/trackTextures';
import { GeoBuilder, meshDataToGeometry, PartBin, sweepProfile, type Vec2 } from './GeoBuilder';

export type TrackPartKey =
  | `top:${TrackStyle}`
  /** Wide box tops: the style's marking-free field variant (materials.getFieldTopMaterial). */
  | `field:${TrackStyle}`
  | 'side:concrete'
  | 'side:metal'
  | 'rail'
  | 'trim'
  | `led:${LedColor}`
  | `spill:${LedColor}`;

/** Default slab thickness (mirrors Ribbon.ts). */
export const DEFAULT_THICKNESS = 1.2;
/** Bottom chamfer of the rendered slab (m). */
const SLAB_CHAMFER = 0.15;

/** Edge cap profile for the RIGHT edge: x = outward (m), y = up from the deck (m); CCW looking forward. */
const TRIM_PROFILE: Vec2[] = [
  [-0.07, 0.0],
  [0.0, 0.0],
  [0.0, -0.3],
  [0.045, -0.3],
  [0.045, 0.014],
  [0.028, 0.032],
  [-0.07, 0.032],
];

/** LED bar profile (right edge) sitting on the cap, protruding past its outer face so it reads from the side. */
function ledProfile(width: number, height: number): Vec2[] {
  const x1 = 0.055;
  const x0 = x1 - width;
  const y0 = 0.018;
  const y1 = y0 + height;
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** Mirrors a right-edge profile for the left edge, preserving CCW winding. */
function mirrorProfile(p: Vec2[]): Vec2[] {
  return p.map(([x, y]) => [-x, y] as Vec2).reverse();
}

export interface EdgeStyle {
  /** LED bar width (m). */
  ledWidth: number;
  /** LED bar height (m). */
  ledHeight: number;
  /** Width of the additive light spill on the deck next to an edge LED (m). 0 = none. */
  spillWidth: number;
  /** Height of the spill down the slab fascia (m). */
  spillDrop: number;
  /**
   * Spill brightness multiplier baked into the vertex colors (1 = calibrated for a night scene,
   * where the LED wash is a hero effect; daylight scenes want a fraction so it never reads as paint).
   */
  spillStrength: number;
}

export const DEFAULT_EDGE_STYLE: EdgeStyle = { ledWidth: 0.16, ledHeight: 0.07, spillWidth: 1.4, spillDrop: 0.7, spillStrength: 1 };

/** Height of the deck spill strip above the drive surface (m). */
const SPILL_LIFT = 0.012;

/**
 * Additive light spill of an edge LED: a strip on the drive surface (from the edge inward) and
 * one down the outer fascia, with a vertex-color falloff (`strength` at the LED -> 0). Gives the
 * saturated "LED lights the concrete" glow independently of the bloom threshold.
 * `points` are the drive-surface edge pushed 6 cm outward (just outside the edge cap); `inward`
 * / `ups` are unit vectors per point; `lift` is the height of the deck strip above the drive
 * surface (m, positive = up) so it never z-fights or hides under the deck.
 */
function addSpill(
  b: GeoBuilder,
  points: Vector3[],
  inward: Vector3[],
  ups: Vector3[],
  arc: number[],
  width: number,
  drop: number,
  lift: number,
  strength: number,
  /** Straight 2-point edges (box perimeters): unit edge direction, to miter the deck strip 45° at both ends. */
  miter?: Vector3,
): void {
  const rows: [number, number, number][] = [
    // [inward offset, up offset, intensity]
    [0.08, lift, 1],
    [0.08 + width * 0.22, lift, 0.42],
    [0.08 + width * 0.55, lift, 0.12],
    [0.08 + width, lift, 0],
  ];
  // fascia strip: 1 cm inside the offset points = just outside the edge cap's outer face
  const side: [number, number, number][] = [
    [0.01, 0.0, 0.9],
    [0.01, -drop * 0.35, 0.35],
    [0.01, -drop, 0],
  ];
  const p = new Vector3();
  const tables: [[number, number, number][], boolean][] = width > 0 ? [[rows, false], [side, true]] : [[side, true]];
  for (const [table, isSide] of tables) {
    const ids: number[][] = [];
    for (let i = 0; i < points.length; i++) {
      const row: number[] = [];
      for (const [inw, up, k] of table) {
        p.copy(points[i]).addScaledVector(inward[i], inw).addScaledVector(ups[i], up);
        // mitered ends: adjacent perimeter strips meet on the diagonal instead of overlapping
        if (miter && !isSide) p.addScaledVector(miter, i === 0 ? inw : -inw);
        const n = isSide ? inward[i].clone().negate() : ups[i];
        row.push(b.vertex(p, n, arc[i], inw - up));
        const c = k * strength;
        b.color(c, c, c);
      }
      ids.push(row);
    }
    const m = table.length;
    for (let i = 0; i < points.length - 1; i++) {
      for (let r = 0; r < m - 1; r++) {
        const a = ids[i][r];
        const c = ids[i][r + 1];
        const d = ids[i + 1][r + 1];
        const e = ids[i + 1][r];
        // double-sided via material; winding irrelevant
        b.quad(a, c, d, e);
      }
    }
  }
}

function sideKeyFor(style: TrackStyle): 'side:concrete' | 'side:metal' {
  return style === 'metal' || style === 'glass' ? 'side:metal' : 'side:concrete';
}

/** Sorted-by-s lookup helpers over a frame list. */
export class FrameIndex {
  constructor(
    readonly frames: TrackFrame[],
    readonly values: number[],
  ) {}
  /** Linear interpolation of the per-frame `values` at arc length s (clamped). */
  valueAt(s: number): number {
    const f = this.frames;
    const n = f.length;
    if (s <= f[0].s) return this.values[0];
    if (s >= f[n - 1].s) return this.values[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (f[mid].s <= s) lo = mid;
      else hi = mid;
    }
    const t = (s - f[lo].s) / Math.max(1e-9, f[hi].s - f[lo].s);
    return this.values[lo] + (this.values[hi] - this.values[lo]) * t;
  }
}

/** Info retained per ribbon for supports, markers and surface probing. */
export interface RibbonInfo {
  piece: RibbonPieceDef;
  frames: TrackFrame[];
  halfWidths: number[];
  thickness: number;
  railHeight: number;
  leftEdge: Vector3[];
  rightEdge: Vector3[];
}

export function addRibbonPiece(bin: PartBin<TrackPartKey>, piece: RibbonPieceDef, edge: EdgeStyle = DEFAULT_EDGE_STYLE): RibbonInfo {
  const thickness = piece.thickness ?? DEFAULT_THICKNESS;
  const railHeight = piece.rails ?? 0;
  const data = buildRibbon(piece.frames, { width: piece.width, thickness, rails: railHeight });
  const frames = piece.frames;
  const hwIndex = new FrameIndex(frames, data.halfWidths);

  // ---- top: layout uv from Ribbon.ts + metric uv1 (lateral m, s) ----
  const top = data.top;
  const uv1 = new Float32Array(top.uvs.length);
  for (let i = 0; i < top.uvs.length; i += 2) {
    const u = top.uvs[i];
    const s = top.uvs[i + 1];
    uv1[i] = (u - 0.5) * 2 * hwIndex.valueAt(s);
    uv1[i + 1] = s;
  }
  bin.add(`top:${piece.style}`, meshDataToGeometry(top, uv1));

  // ---- slab sides / underside / caps ----
  const sides = new GeoBuilder();
  buildSlabSides(sides, frames, data.leftEdge, data.rightEdge, data.halfWidths, thickness);
  bin.add(sideKeyFor(piece.style), sides.build());

  // ---- rails ----
  if (data.rails) bin.add('rail', meshDataToGeometry(data.rails));

  // ---- edge caps + LEDs ----
  const lift = railHeight > 0 ? railHeight : 0;
  const ups = frames.map((f) => f.up);
  const rights = frames.map((f) => f.right);
  const arc = frames.map((f) => f.s);
  const lift3 = (pts: Vector3[]) => (lift > 0 ? pts.map((p, i) => p.clone().addScaledVector(ups[i], lift)) : pts);
  const leftPts = lift3(data.leftEdge);
  const rightPts = lift3(data.rightEdge);
  const trim = new GeoBuilder();
  sweepProfile(trim, rightPts, rights, ups, TRIM_PROFILE, { closed: true, caps: true, arc });
  sweepProfile(trim, leftPts, rights, ups, mirrorProfile(TRIM_PROFILE), { closed: true, caps: true, arc });
  bin.add('trim', trim.build());

  const light = piece.edgeLights ?? 'none';
  if (light !== 'none') {
    const led = new GeoBuilder();
    const prof = ledProfile(edge.ledWidth, edge.ledHeight);
    sweepProfile(led, rightPts, rights, ups, prof, { closed: true, caps: true, arc });
    sweepProfile(led, leftPts, rights, ups, mirrorProfile(prof), { closed: true, caps: true, arc });
    bin.add(`led:${light}`, led.build());
    if (edge.spillWidth > 0 && edge.spillStrength > 0) {
      const spill = new GeoBuilder().withColors();
      const lefts = rights.map((r) => r.clone().negate());
      // the deck strip floats SPILL_LIFT above the drive surface (railed decks: fascia only, the
      // LED sits on the rail top), the fascia strip hangs just outside the edge cap
      const surf = (pts: Vector3[], outward: Vector3[]) => pts.map((q, i) => q.clone().addScaledVector(outward[i], 0.06));
      const deckWidth = railHeight > 0 ? 0 : edge.spillWidth;
      addSpill(spill, surf(rightPts, rights), lefts, ups, arc, deckWidth, edge.spillDrop, SPILL_LIFT, edge.spillStrength);
      addSpill(spill, surf(leftPts, lefts), rights, ups, arc, deckWidth, edge.spillDrop, SPILL_LIFT, edge.spillStrength);
      bin.add(`spill:${light}`, spill.build());
    }
  }

  return {
    piece,
    frames,
    halfWidths: data.halfWidths,
    thickness,
    railHeight,
    leftEdge: data.leftEdge,
    rightEdge: data.rightEdge,
  };
}

/**
 * Slab sides with a small bottom chamfer. Per frame: TL/TR = drive-surface edges, the fascia runs
 * down to thickness - chamfer, a 45° chamfer, then the underside. Smooth along s, flat across faces.
 * UVs: fascia u = s, v = depth (m); underside u = s, v = 2 + lateral * 0.5 (keeps clear of the
 * fascia reveal line); caps u = lateral, v = depth.
 */
function buildSlabSides(
  b: GeoBuilder,
  frames: TrackFrame[],
  tl: Vector3[],
  tr: Vector3[],
  hw: number[],
  thickness: number,
): void {
  const n = frames.length;
  const ch = Math.min(SLAB_CHAMFER, thickness * 0.3);
  const fasciaDepth = thickness - ch;
  const L1: Vector3[] = [];
  const L2: Vector3[] = [];
  const R1: Vector3[] = [];
  const R2: Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    L1.push(tl[i].clone().addScaledVector(f.up, -fasciaDepth));
    L2.push(tl[i].clone().addScaledVector(f.up, -thickness).addScaledVector(f.right, ch));
    R1.push(tr[i].clone().addScaledVector(f.up, -fasciaDepth));
    R2.push(tr[i].clone().addScaledVector(f.up, -thickness).addScaledVector(f.right, -ch));
  }
  const nrm = new Vector3();
  // strips: [from, to, normal fn, v(from), v(to)]
  type Strip = {
    a: Vector3[];
    c: Vector3[];
    normal: (f: TrackFrame) => Vector3;
    va: (i: number) => number;
    vc: (i: number) => number;
  };
  const diag = Math.SQRT1_2;
  const strips: Strip[] = [
    // left fascia: TL (top) -> L1 (bottom); outward = -right
    { a: tl, c: L1, normal: (f) => nrm.copy(f.right).negate(), va: () => 0, vc: () => fasciaDepth },
    {
      a: L1,
      c: L2,
      normal: (f) => nrm.copy(f.right).multiplyScalar(-diag).addScaledVector(f.up, -diag),
      va: () => fasciaDepth,
      vc: () => fasciaDepth + ch * Math.SQRT2,
    },
    // underside: L2 -> R2; outward = -up
    { a: L2, c: R2, normal: (f) => nrm.copy(f.up).negate(), va: () => 2, vc: (i) => 2 + (hw[i] * 2 - 2 * ch) * 0.5 },
    {
      a: R2,
      c: R1,
      normal: (f) => nrm.copy(f.right).multiplyScalar(diag).addScaledVector(f.up, -diag),
      va: () => fasciaDepth + ch * Math.SQRT2,
      vc: () => fasciaDepth,
    },
    // right fascia: R1 -> TR
    { a: R1, c: tr, normal: (f) => nrm.copy(f.right), va: () => fasciaDepth, vc: () => 0 },
  ];
  for (const st of strips) {
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      const f = frames[i];
      const nn = st.normal(f).clone();
      ids.push(b.vertex(st.a[i], nn, f.s, st.va(i)), b.vertex(st.c[i], nn, f.s, st.vc(i)));
    }
    // Winding: for the left fascia, a = top, c = bottom, strip runs along +forward.
    for (let i = 0; i < n - 1; i++) {
      const a0 = ids[i * 2];
      const c0 = ids[i * 2 + 1];
      const a1 = ids[(i + 1) * 2];
      const c1 = ids[(i + 1) * 2 + 1];
      b.quad(a0, a1, c1, c0);
    }
  }
  // caps: polygon TL, L1, L2, R2, R1, TR at both ends (fan from the first corner)
  const cap = (i: number, outward: Vector3, flip: boolean) => {
    const f = frames[i];
    const pts = [tl[i], L1[i], L2[i], R2[i], R1[i], tr[i]];
    const ids = pts.map((p) => {
      const rel = p.clone().sub(tl[i]);
      return b.vertex(p, outward, rel.dot(f.right), -rel.dot(f.up));
    });
    for (let k = 1; k < pts.length - 1; k++) {
      if (flip) b.tri(ids[0], ids[k + 1], ids[k]);
      else b.tri(ids[0], ids[k], ids[k + 1]);
    }
  };
  // Seen from behind (looking along +forward) the corner list is CCW => fan normal = -forward.
  cap(0, frames[0].forward.clone().negate(), false);
  cap(n - 1, frames[n - 1].forward.clone(), true);
}

/* ------------------------------------------------------------------ */
/* Box pieces                                                          */
/* ------------------------------------------------------------------ */

export interface BoxInfo {
  piece: BoxPieceDef;
  matrix: Matrix4;
  quaternion: Quaternion;
  center: Vector3;
}

export function addBoxPiece(bin: PartBin<TrackPartKey>, piece: BoxPieceDef, edge: EdgeStyle = DEFAULT_EDGE_STYLE): BoxInfo {
  const [sx, sy, sz] = piece.size;
  const q = quatFromRotationDeg(piece.rotationDeg);
  const center = new Vector3(...piece.center);
  const m = new Matrix4().compose(center, q, new Vector3(1, 1, 1));
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  const P = (x: number, y: number, z: number) => new Vector3(x, y, z).applyMatrix4(m);

  // top: u across (x) in layout repeats, v = meters along -z (forward). Layouts are authored for a
  // nominal width (u = 0..1); wide boxes tile them a whole number of times so panels keep their
  // authored size instead of stretching across a 200 m arena — and styles with linear markings
  // (lanes, edge / center lines, chevrons) switch to their marking-free field variant there, so
  // an arena floor never reads as a multi-lane highway.
  const top = new GeoBuilder();
  const up = new Vector3(0, 1, 0).applyQuaternion(q);
  const layout = getLayoutTextures(piece.style);
  const field = sx > layout.nominalWidth * 1.5 ? getFieldLayoutTextures(piece.style) : null;
  const repeats = Math.max(1, Math.round(sx / (field ?? layout).nominalWidth));
  // light tessellation only (lighting is per pixel); capped so huge decks stay cheap
  const cols = Math.min(32, Math.max(1, Math.round(sx / 8)));
  const rows = Math.min(32, Math.max(1, Math.round(sz / 8)));
  const ids: number[] = [];
  for (let r = 0; r <= rows; r++) {
    const v = (r / rows) * sz;
    const z = hz - v;
    for (let c = 0; c <= cols; c++) {
      const t = c / cols;
      const x = -hx + t * sx;
      ids.push(top.vertex(P(x, hy, z), up, t * repeats, v, x, v));
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = ids[r * (cols + 1) + c];
      const b2 = ids[r * (cols + 1) + c + 1];
      const c2 = ids[(r + 1) * (cols + 1) + c + 1];
      const d = ids[(r + 1) * (cols + 1) + c];
      top.quad(a, b2, c2, d);
    }
  }
  bin.add(field ? `field:${piece.style}` : `top:${piece.style}`, top.build());

  // sides + bottom (metric, v = depth below the top for the fascia reveal)
  const sides = new GeoBuilder();
  const faces: [Vector3, Vector3, Vector3, Vector3][] = [
    [P(-hx, hy, hz), P(-hx, -hy, hz), P(hx, -hy, hz), P(hx, hy, hz)], // +z (back)
    [P(hx, hy, -hz), P(hx, -hy, -hz), P(-hx, -hy, -hz), P(-hx, hy, -hz)], // -z (front)
    [P(hx, hy, hz), P(hx, -hy, hz), P(hx, -hy, -hz), P(hx, hy, -hz)], // +x
    [P(-hx, hy, -hz), P(-hx, -hy, -hz), P(-hx, -hy, hz), P(-hx, hy, hz)], // -x
  ];
  for (const [a, b2, c, d] of faces) {
    // a = top-left, b2 = bottom-left, c = bottom-right, d = top-right (seen from outside)
    const n = new Vector3().subVectors(b2, a).cross(new Vector3().subVectors(d, a)).normalize();
    const w = a.distanceTo(d);
    const ia = sides.vertex(a, n, 0, 0);
    const ib = sides.vertex(b2, n, 0, sy);
    const ic = sides.vertex(c, n, w, sy);
    const id = sides.vertex(d, n, w, 0);
    sides.quad(ia, ib, ic, id);
  }
  sides.flatQuad(P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, -hy, hz), P(-hx, -hy, hz), 0, 2);
  bin.add(sideKeyFor(piece.style), sides.build());

  // perimeter edge caps / LEDs (CCW seen from above: -x,+z -> +x,+z -> +x,-z -> -x,-z)
  const corners = [P(-hx, hy, hz), P(hx, hy, hz), P(hx, hy, -hz), P(-hx, hy, -hz)];
  const trim = new GeoBuilder();
  const led = new GeoBuilder();
  const spill = new GeoBuilder().withColors();
  const light: EdgeLight = piece.edgeLights ?? 'none';
  const prof = ledProfile(edge.ledWidth, edge.ledHeight);
  for (let k = 0; k < 4; k++) {
    const a = corners[k];
    const c = corners[(k + 1) % 4];
    // walking CCW from above, the outward side is to the right of the walking direction
    const dir = new Vector3().subVectors(c, a).normalize();
    const right = new Vector3().crossVectors(dir, up).normalize();
    // extend slightly so corners overlap cleanly
    const pts = [a.clone().addScaledVector(dir, -0.04), c.clone().addScaledVector(dir, 0.04)];
    sweepProfile(trim, pts, [right, right], [up, up], TRIM_PROFILE, { closed: true, caps: true });
    if (light !== 'none') {
      sweepProfile(led, pts, [right, right], [up, up], prof, { closed: true, caps: true });
      if (edge.spillWidth > 0 && edge.spillStrength > 0) {
        const inward = right.clone().negate();
        // corners pushed 6 cm outward on both axes so the mitered strips meet exactly on the diagonal
        const edgePts = [
          a.clone().addScaledVector(right, 0.06).addScaledVector(dir, -0.06),
          c.clone().addScaledVector(right, 0.06).addScaledVector(dir, 0.06),
        ];
        addSpill(spill, edgePts, [inward, inward], [up, up], [0, a.distanceTo(c)], edge.spillWidth, edge.spillDrop, SPILL_LIFT, edge.spillStrength, dir);
      }
    }
  }
  bin.add('trim', trim.build());
  if (light !== 'none') {
    bin.add(`led:${light}`, led.build());
    if (!spill.isEmpty()) bin.add(`spill:${light}`, spill.build());
  }

  return { piece, matrix: m, quaternion: q, center };
}
