/**
 * Render-only structural supports generated from the level's ribbons:
 *
 *  - PYLONS under decks up to 36° (every ~30 m): a slender tapered shaft with shadow grooves that
 *    flares (chalice) into a thin pier head flush under the deck, plunging into the cloud sea.
 *    Skipped where another deck/box is below or at deck level. All pylons of a level are merged
 *    into one mesh (1 draw call; receives but does not cast shadows).
 *  - TRUSS BACKING behind steep / vertical / inverted sections: a box truss hugging the back of
 *    the slab (it becomes the "truss arm" over inverted sections) plus, behind near-vertical
 *    walls, a lattice tower tied to it — the Tesla crescent structure. One InstancedMesh.
 */
import { Group, Matrix4, Mesh, Quaternion, Vector3, type InstancedMesh } from 'three';
import type { LevelDef, TrackFrame } from '@/game/types';
import { frameAt } from '@/game/track/TrackPath';
import { getLevelMaterials } from '../materials';
import { GeoBuilder, loftSections, taperedPrism, type LoftSection, type Vec2 } from './GeoBuilder';
import { latticeTower, MemberBatch, sweptBoxTruss } from './truss';
import type { BoxInfo, RibbonInfo } from './trackGeometry';
import type { SurfaceProbe } from './surfaceProbe';

export interface SupportOptions {
  /** Disable all auto supports. */
  enabled?: boolean;
  /** World Y that pylons / towers extend down to. Default: level.killY - 400 (deep in the cloud sea). */
  baseY?: number;
  /** Target pylon spacing along a ribbon (m). Default 30. */
  pylonSpacing?: number;
  /** Max deck slope that still gets pylons (deg). Default 36. */
  maxPylonSlopeDeg?: number;
  /** Deck slope from which truss backing is generated (deg). Default 36 (no gap with pylons). */
  trussSlopeDeg?: number;
  /** Lattice tower behind near-vertical walls. Default true. */
  towers?: boolean;
  /** Cast shadows from the truss. Default true. */
  trussShadows?: boolean;
}

export interface SupportsBuild {
  group: Group;
  dispose(): void;
}

const DEG = Math.PI / 180;

/** Pylon shaft section (x across the deck, z along), CCW from +y, with shadow grooves on the narrow faces. */
function shaftSection(hx: number, hz: number): Vec2[] {
  const c = Math.min(hx, hz) * 0.22;
  const g = hz * 0.34;
  const e = Math.min(hx * 0.12, 0.22);
  return [
    [-hx + c, hz],
    [hx - c, hz],
    [hx, hz - c],
    [hx, g / 2],
    [hx - e, g / 2],
    [hx - e, -g / 2],
    [hx, -g / 2],
    [hx, -hz + c],
    [hx - c, -hz],
    [-hx + c, -hz],
    [-hx, -hz + c],
    [-hx, -g / 2],
    [-hx + e, -g / 2],
    [-hx + e, g / 2],
    [-hx, g / 2],
    [-hx, hz - c],
  ];
}

/** Extrudes a convex polygon given in (x, y), CCW seen from +z, between z0 < z1. */
export function extrudeXY(b: GeoBuilder, poly: Vec2[], z0: number, z1: number, m: Matrix4): void {
  const P = (x: number, y: number, z: number) => new Vector3(x, y, z).applyMatrix4(m);
  const n = poly.length;
  let perim = 0;
  for (let k = 0; k < n; k++) {
    const [x0, y0] = poly[k];
    const [x1, y1] = poly[(k + 1) % n];
    b.flatQuad(P(x0, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y0, z1), perim, z0);
    perim += Math.hypot(x1 - x0, y1 - y0);
  }
  const front = new Vector3(0, 0, 1).transformDirection(m);
  const back = front.clone().negate();
  const fIds = poly.map(([x, y]) => b.vertex(P(x, y, z1), front, x, y));
  const bIds = poly.map(([x, y]) => b.vertex(P(x, y, z0), back, x, y));
  for (let k = 1; k < n - 1; k++) {
    b.tri(fIds[0], fIds[k], fIds[k + 1]);
    b.tri(bIds[0], bIds[k + 1], bIds[k]);
  }
}

export interface PylonParams {
  /** Deck underside center (top of the pier cap). */
  top: Vector3;
  /** Deck orientation (pier cap follows it). */
  quaternion: Quaternion;
  /** Deck width (m) — sizes the cap and shaft. */
  deckWidth: number;
  /** World Y of the shaft bottom. */
  bottomY: number;
}

/**
 * Appends one pylon: a slender tapered shaft that flares smoothly (chalice) into a wide, thin
 * pier head flush under the deck. The head follows the deck orientation (yaw + pitch + bank) so
 * it sits flush on slopes; the shaft is vertical and yaw-aligned with the deck heading, and the
 * top of the flare is morphed onto the tilted bottom edge of the head, so on steep or banked
 * decks it meets the head exactly instead of poking up through the slab on the downhill side.
 */
export function addPylon(b: GeoBuilder, p: PylonParams): void {
  const W = p.deckWidth;
  const hx = Math.min(3.2, Math.max(1.3, W * 0.075)); // shaft half width (across the deck)
  const hz = hx * 0.58; // shaft half depth (along the deck)
  const span = W * 0.34; // head half span
  const headHz = hz * 1.9;
  const flareH = Math.min(18, Math.max(7, span * 1.25));
  // deck frame: head top at the deck underside
  const fwd = new Vector3(0, 0, -1).applyQuaternion(p.quaternion);
  const yaw = Math.atan2(-fwd.x, -fwd.z);
  const headM = new Matrix4().compose(p.top, p.quaternion, new Vector3(1, 1, 1));
  // fascia band of the head (follows the deck slope); open at the bottom, closed by the flare
  const band = 0.55;
  const headProfile = shaftSection(span, headHz);
  taperedPrism(b, headProfile, -band, 0.02, [1, 1], [1, 1], { matrix: headM, capBottom: false });
  // the flare + shaft are vertical (yaw only), starting just under the band
  const bandBottom = new Vector3(0, -band, 0).applyMatrix4(headM);
  const topY = bandBottom.y + 0.05;
  const len = topY - p.bottomY;
  if (len <= flareH + 2) return;
  const m = new Matrix4().compose(
    new Vector3(bandBottom.x, 0, bandBottom.z),
    new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw),
    new Vector3(1, 1, 1),
  );
  const shaft = shaftSection(hx, hz);
  const sxTop = span / hx;
  const szTop = headHz / hz;
  const sections: LoftSection[] = [];
  const blend: number[] = [];
  const baseTaper = Math.max(0.5, 1 - len * 0.0012);
  sections.push({ y: p.bottomY, sx: baseTaper, sz: baseTaper });
  blend.push(0);
  // flare: ease-in curve from the neck (scale 1) up to the head
  const steps = 9;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const e = Math.pow(t, 2.6);
    sections.push({ y: topY - flareH * (1 - t), sx: 1 + (sxTop - 1) * e, sz: 1 + (szTop - 1) * e });
    blend.push(e);
  }
  // Per profile point: offset from the natural (horizontal) top ring to the band's bottom ring
  // (2 cm inside the open sleeve, 0.5 % inset so the faces never z-fight), blended in with the
  // flare's own easing so the neck stays vertical.
  const offsets = shaft.map(([x, z], k) => {
    const natural = new Vector3(x * sxTop, topY, z * szTop).applyMatrix4(m);
    const [bx, bz] = headProfile[k];
    return new Vector3(bx * 0.995, -band + 0.02, bz * 0.995).applyMatrix4(headM).sub(natural);
  });
  loftSections(b, shaft, sections, m, (v, section, k) => {
    const e = blend[section];
    if (e > 0) v.addScaledVector(offsets[k], e);
  });
}

interface SteepRange {
  ribbon: RibbonInfo;
  s0: number;
  s1: number;
}

function steepRanges(rb: RibbonInfo, cosLimit: number): SteepRange[] {
  const out: SteepRange[] = [];
  let start = -1;
  const f = rb.frames;
  for (let i = 0; i < f.length; i++) {
    const steep = f[i].up.y < cosLimit;
    if (steep && start < 0) start = i;
    if ((!steep || i === f.length - 1) && start >= 0) {
      const end = steep ? i : i - 1;
      if (f[end].s - f[start].s > 4) out.push({ ribbon: rb, s0: f[start].s, s1: f[end].s });
      start = -1;
    }
  }
  return out;
}

export function buildSupports(
  level: LevelDef,
  ribbons: RibbonInfo[],
  _boxes: BoxInfo[],
  probe: SurfaceProbe,
  opts: SupportOptions = {},
): SupportsBuild {
  const group = new Group();
  group.name = 'supports';
  const disposables: { dispose(): void }[] = [];
  if (opts.enabled === false) return { group, dispose() {} };
  const lib = getLevelMaterials();
  const baseY = opts.baseY ?? level.killY - 400;
  const spacing = opts.pylonSpacing ?? 30;
  const cosPylon = Math.cos((opts.maxPylonSlopeDeg ?? 36) * DEG);
  const cosTruss = Math.cos((opts.trussSlopeDeg ?? 36) * DEG);

  // ---------------- pylons ----------------
  const pylons = new GeoBuilder();
  for (const rb of ribbons) {
    if (rb.piece.supports === false) continue;
    const f0 = rb.frames[0].s;
    const f1 = rb.frames[rb.frames.length - 1].s;
    const L = f1 - f0;
    const count = Math.max(1, Math.round(L / spacing));
    for (let k = 0; k < count; k++) {
      const s = f0 + ((k + 0.5) * L) / count;
      const f: TrackFrame = frameAt(rb.frames, s);
      if (f.up.y < cosPylon) continue;
      const hwI = rb.halfWidths[Math.min(rb.halfWidths.length - 1, nearestIndex(rb.frames, s))];
      const top = f.position.clone().addScaledVector(f.up, -rb.thickness);
      // Skip when another surface is below the pylon (it would be an obstacle physics does not
      // know about) or right at deck level (the deck rests on a platform / box already).
      const hits = probe.verticalHits(top.x, top.z, top.y + rb.thickness + 2, baseY, hwI * 0.25, { ribbon: rb, s, radius: hwI * 2 + 6 });
      if (hits.length > 0) continue;
      addPylon(pylons, { top, quaternion: f.quaternion, deckWidth: hwI * 2, bottomY: baseY });
    }
  }
  if (!pylons.isEmpty()) {
    const geo = pylons.build();
    const mesh = new Mesh(geo, lib.pylon);
    mesh.name = 'pylons';
    // pylons hang below the decks: they receive deck shadows but casting would only cost
    // shadow-pass time (the sun frustum follows the car above the decks)
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    disposables.push(geo);
  }

  // ---------------- truss backing + towers ----------------
  const batch = new MemberBatch();
  for (const rb of ribbons) {
    if (rb.piece.supports === false) continue;
    for (const range of steepRanges(rb, cosTruss)) {
      buildTrussBacking(batch, range, probe, baseY, opts.towers ?? true);
    }
  }
  const truss: InstancedMesh | null = batch.build(lib.steel, opts.trussShadows ?? true);
  if (truss) {
    truss.name = 'truss';
    group.add(truss);
    disposables.push(truss);
  }

  return {
    group,
    dispose() {
      // GPU resources only: the scene graph stays intact so a StrictMode re-mount can reuse it
      for (const d of disposables) d.dispose();
    },
  };
}

function nearestIndex(frames: TrackFrame[], s: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].s <= s) lo = mid;
    else hi = mid;
  }
  return s - frames[lo].s < frames[hi].s - s ? lo : hi;
}

/**
 * Box truss along the back of a steep section; a lattice tower behind its near-vertical part,
 * tied to the truss at regular heights, standing on the surface below or plunging to baseY.
 */
function buildTrussBacking(batch: MemberBatch, range: SteepRange, probe: SurfaceProbe, baseY: number, tower: boolean): void {
  const rb = range.ribbon;
  // extend a little into the gentler part for a continuous look
  const s0 = Math.max(rb.frames[0].s, range.s0 - 6);
  const s1 = Math.min(rb.frames[rb.frames.length - 1].s, range.s1 + 2);
  const meanHw = rb.halfWidths.reduce((a, b) => a + b, 0) / rb.halfWidths.length;
  const depth = Math.min(5, Math.max(2.4, meanHw * 0.42));
  const halfW = meanHw * 0.78;
  const bay = Math.max(2.6, depth * 0.95);
  const n = Math.max(2, Math.round((s1 - s0) / bay));
  const points: Vector3[] = [];
  const rights: Vector3[] = [];
  const ups: Vector3[] = [];
  const frames: TrackFrame[] = [];
  for (let i = 0; i <= n; i++) {
    const f = frameAt(rb.frames, s0 + ((s1 - s0) * i) / n);
    frames.push(f);
    points.push(f.position.clone().addScaledVector(f.up, -(rb.thickness + 0.2)));
    rights.push(f.right.clone());
    ups.push(f.up.clone());
  }
  const chord = Math.max(0.14, depth * 0.06);
  const spine = sweptBoxTruss(batch, {
    points,
    rights,
    ups,
    halfWidth: halfW,
    depth,
    chordRadius: chord,
    braceRadius: chord * 0.55,
  });
  // short posts from the slab underside to the inner chords
  for (let i = 0; i < points.length; i += 2) {
    const f = frames[i];
    const under = f.position.clone().addScaledVector(f.up, -rb.thickness);
    batch.add(under.clone().addScaledVector(f.right, -halfW), spine.innerL[i], chord * 0.5);
    batch.add(under.clone().addScaledVector(f.right, halfW), spine.innerR[i], chord * 0.5);
  }

  if (!tower) return;
  // near-vertical samples define the wall the tower stands behind
  const wall: number[] = [];
  for (let i = 0; i < frames.length; i++) if (Math.abs(frames[i].up.y) < 0.4) wall.push(i);
  if (wall.length < 2) return;
  const back = new Vector3();
  const lat = new Vector3();
  const center = new Vector3();
  for (const i of wall) {
    back.add(new Vector3(-frames[i].up.x, 0, -frames[i].up.z));
    lat.add(new Vector3(frames[i].right.x, 0, frames[i].right.z));
    center.add(points[i]);
  }
  back.normalize();
  lat.normalize();
  center.divideScalar(wall.length);
  // farthest point of the whole truss along `back`
  let maxBack = -Infinity;
  let topY = -Infinity;
  let minY = Infinity;
  for (let i = 0; i < points.length; i++) {
    for (const p of [spine.outerL[i], spine.outerR[i], spine.innerL[i], spine.innerR[i]]) {
      maxBack = Math.max(maxBack, p.dot(back));
      topY = Math.max(topY, p.y);
      minY = Math.min(minY, p.y);
    }
  }
  const towerDepth = Math.min(12, Math.max(6, (topY - minY) * 0.16));
  const towerWidth = halfW * 2 * 1.05;
  const gap = 1.2;
  const along = center.dot(back);
  const base = center.clone().addScaledVector(back, maxBack - along + gap + towerDepth / 2);
  // stand on the highest surface under the tower, or plunge into the cloud sea
  const hits = probe.verticalHits(base.x, base.z, topY, baseY, 0);
  const groundY = hits.length > 0 ? hits[0] : baseY;
  base.y = groundY;
  const height = topY + 2 - groundY;
  if (height < 6) return;
  // tower local X = lateral axis, Z = back axis
  const yaw = Math.atan2(lat.z, lat.x) * -1;
  const rings = latticeTower(batch, {
    base,
    height,
    width: towerWidth,
    depth: towerDepth,
    yaw,
    bay: Math.max(3, towerDepth * 0.6),
    legRadius: chord * 1.5,
    braceRadius: chord * 0.65,
    pattern: 'x',
  });
  // ties: tower front nodes -> nearest truss outer chord nodes at the same height
  const front = (ring: Vector3[]) => {
    // the two corners closest to the wall
    const sorted = [...ring].sort((a, b) => a.dot(back) - b.dot(back));
    const pair = sorted.slice(0, 2);
    pair.sort((a, b) => a.dot(lat) - b.dot(lat));
    return pair;
  };
  for (let l = 1; l < rings.length; l += 2) {
    const [fl, fr] = front(rings[l]);
    const y = fl.y;
    let bestI = -1;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(spine.outerL[i].y - y);
      const horiz = Math.abs(spine.outerL[i].dot(back) - fl.dot(back));
      if (d < bestD && horiz < 30) {
        bestD = d;
        bestI = i;
      }
    }
    if (bestI < 0 || bestD > 3) continue;
    batch.add(fl, spine.outerL[bestI], chord * 0.8);
    batch.add(fr, spine.outerR[bestI], chord * 0.8);
  }
}
