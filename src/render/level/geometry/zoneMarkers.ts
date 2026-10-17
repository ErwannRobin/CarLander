/**
 * Visible zone markers:
 *  - target     -> concentric precision rings + cyan bullseye, conformed onto the deck 2 cm above it
 *                  and clipped at the deck edges
 *  - finish     -> monumental warm-white arch at the far end of the zone (on a ribbon: legs outside
 *                  the deck, plunging below it; on a box platform: spanning the zone, standing on
 *                  it), cyan underside light bar and tracked FINISH lettering on a graphite band,
 *                  facing the approach (ZoneDef.label overrides the text)
 *  - gate       -> slim titanium ring with an inner cyan light ring (zone local XY plane)
 *  - checkpoint -> slim rectangular frame (only when `visible: true`)
 *  - trigger    -> (only when `visible: true`, e.g. the L3 RELEASE zone) deck marking conformed to
 *                  the drive surface under the zone — entry / exit bars, forward chevrons and the
 *                  ZoneDef.label lettering; works on inverted decks. A trigger with no deck under
 *                  it (aerial) gets the checkpoint frame instead.
 * Visibility follows ZoneDef.visible (default true for target / gate / finish).
 */
import {
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  TorusGeometry,
  Vector3,
  type BufferGeometry,
  type Material,
  type Texture,
} from 'three';
import type { LevelDef, ZoneDef } from '@/game/types';
import { quatFromRotationDeg } from '@/game/track/zones';
import { PALETTE } from '@/render/palette';
import { getLevelMaterials } from '../materials';
import { drawZoneBand, getTargetTextures } from '../textures/markerTextures';
import { drawLabel, ensureFonts } from '../textures/textTextures';
import { chamferRect, GeoBuilder, taperedPrism } from './GeoBuilder';
import type { SurfaceHit, SurfaceProbe } from './surfaceProbe';

export interface MarkersBuild {
  group: Group;
  dispose(): void;
}

const DEFAULT_VISIBLE: Record<ZoneDef['purpose'], boolean> = {
  target: true,
  finish: true,
  gate: true,
  checkpoint: false,
  trigger: false,
};

export function buildZoneMarkers(level: LevelDef, probe: SurfaceProbe): MarkersBuild {
  const group = new Group();
  group.name = 'zone-markers';
  const geos: BufferGeometry[] = [];
  const mats: Material[] = [];
  for (const zone of level.zones) {
    if (!(zone.visible ?? DEFAULT_VISIBLE[zone.purpose])) continue;
    switch (zone.purpose) {
      case 'target':
        buildTarget(group, zone, probe, geos, mats);
        break;
      case 'finish':
        buildFinishArch(group, zone, probe, geos, mats);
        break;
      case 'gate':
        buildRingGate(group, zone, geos);
        break;
      case 'checkpoint':
        buildCheckpoint(group, zone, geos);
        break;
      case 'trigger':
        buildTrigger(group, zone, probe, geos, mats);
        break;
    }
  }
  return {
    group,
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of mats) {
        // per-level textures (finish lettering, trigger artwork) are owned here; target textures are cached
        const owned = m.userData.ownedTextures as Texture[] | undefined;
        if (owned) for (const t of owned) t.dispose();
        m.dispose();
      }
    },
  };
}

function zoneFrame(zone: ZoneDef) {
  const q = quatFromRotationDeg(zone.rotationDeg);
  const center = new Vector3(...zone.center);
  const right = new Vector3(1, 0, 0).applyQuaternion(q);
  const up = new Vector3(0, 1, 0).applyQuaternion(q);
  const forward = new Vector3(0, 0, -1).applyQuaternion(q);
  return { q, center, right, up, forward };
}

/* ------------------------------------------------------------------ */
/* Deck decals (target rings, trigger markings)                         */
/* ------------------------------------------------------------------ */

/** Decal vertices stop this far inside a deck edge (under the 7 cm edge cap). */
const DECAL_EDGE_INSET = 0.07;
/** Decal height above the drive surface (m). */
const DECAL_LIFT = 0.02;

interface DeckDecal {
  geo: BufferGeometry;
  /** Surface found under the zone center (deck width there, orientation). */
  centerHit: SurfaceHit;
}

/**
 * A (cols x rows) grid over the zone's local XZ footprint, conformed onto the drive surface under
 * the zone, 2 cm above it. UVs map the zone footprint to 0..1 (u = right, v = forward; computed
 * from the final surface position, so sloped decks under a flat zone are not distorted). Points
 * beyond a deck edge slide back onto the deck along its lateral axis (and points past a ribbon's
 * start / end slide back along the zone's forward axis), so artwork larger than the deck is
 * cleanly cut at its edges instead of hanging in the air. Null when no surface is under the zone
 * center.
 *
 * Inverted decks: zones are often authored yaw-only (zone up = world +Y) even where the drive
 * side faces down. The surface is then probed from the zone's -up side, and u follows the deck's
 * own right axis (right x forward = surface normal), so artwork reads unmirrored for the driver.
 */
function conformedDecal(zone: ZoneDef, probe: SurfaceProbe, cols: number, rows: number, inset = 0.985): DeckDecal | null {
  const { center, right, up, forward } = zoneFrame(zone);
  const [hx, hy, hz] = zone.halfSize;
  const rx = hx * inset;
  const rz = hz * inset;
  // probe from beyond the zone top so the deck under the zone is found even if the center is low
  const lift = hy + 2;
  const maxDist = lift + hy + 30;
  // generous lateral margin: points beyond the deck edge still map to that deck (then get clipped)
  const margin = Math.max(rx, rz) + 1;
  let side = 1;
  let centerHit = probe.probe(center.clone().addScaledVector(up, lift), maxDist, margin);
  if (!centerHit) {
    side = -1;
    centerHit = probe.probe(center.clone().addScaledVector(up, -lift), maxDist, margin);
  }
  if (!centerHit) return null;
  const lat = right.clone().multiplyScalar(centerHit.normal.dot(up) < 0 ? -1 : 1);
  const b = new GeoBuilder();
  const q = new Vector3();
  const s = new Vector3();
  const rel = new Vector3();
  for (let j = 0; j <= rows; j++) {
    const zf = (j / rows) * 2 - 1; // -1 back .. +1 forward
    for (let i = 0; i <= cols; i++) {
      const xr = (i / cols) * 2 - 1;
      q.copy(center).addScaledVector(lat, xr * rx).addScaledVector(forward, zf * rz).addScaledVector(up, side * lift);
      let hit = probe.probe(q, maxDist, margin);
      if (!hit && zf !== 0) {
        // past the deck's start / end: slide back towards the zone's center row (binary search)
        // so the artwork stops at the deck end instead of continuing into the air
        let lo = 0;
        let hi = 1;
        for (let it = 0; it < 8; it++) {
          const mid = (lo + hi) / 2;
          const h = probe.probe(s.copy(q).addScaledVector(forward, -zf * rz * mid), maxDist, margin);
          if (h) {
            hit = h;
            hi = mid;
          } else lo = mid;
        }
      }
      let p: Vector3;
      let n: Vector3;
      if (hit) {
        p = hit.point;
        n = hit.normal;
        const edge = Math.max(0, hit.halfWidth - DECAL_EDGE_INSET);
        if (Math.abs(hit.lateral) > edge) p.addScaledVector(hit.right, Math.sign(hit.lateral) * edge - hit.lateral);
      } else {
        // nothing anywhere on this line (gap in the deck): continue the plane through the center hit
        const d = q.clone().sub(centerHit.point);
        p = q.clone().addScaledVector(centerHit.normal, -d.dot(centerHit.normal));
        n = centerHit.normal;
      }
      rel.subVectors(p, center);
      const x = rel.dot(lat);
      const z = rel.dot(forward);
      p.addScaledVector(n, DECAL_LIFT);
      b.vertex(p, n, (x / rx) * 0.5 + 0.5, (z / rz) * 0.5 + 0.5, x, z);
    }
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i;
      // rows advance forward, columns along `lat`: lat x forward = surface normal => CCW seen
      // from the drive side (front faces)
      b.quad(a, a + 1, a + cols + 2, a + cols + 1);
    }
  }
  return { geo: b.build(), centerHit };
}

/** Transparent, self-lit decal material that never z-fights with the deck (offset + 2 cm lift). */
function decalMaterial(map: Texture | null, emissiveMap: Texture | null, emissiveIntensity: number): MeshStandardMaterial {
  return new MeshStandardMaterial({
    map,
    emissiveMap,
    emissive: '#ffffff',
    emissiveIntensity,
    transparent: true,
    depthWrite: false,
    roughness: 0.55,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

function decalMesh(geo: BufferGeometry, mat: Material, name: string): Mesh {
  const mesh = new Mesh(geo, mat);
  mesh.name = name;
  mesh.receiveShadow = true;
  mesh.renderOrder = 1;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

function buildTarget(group: Group, zone: ZoneDef, probe: SurfaceProbe, geos: BufferGeometry[], mats: Material[]): void {
  const decal = conformedDecal(zone, probe, 40, 40);
  if (!decal) {
    console.warn(`[LevelGeometry] target zone "${zone.id}" has no deck under it — marker skipped`);
    return;
  }
  const tex = getTargetTextures();
  const mat = decalMaterial(tex.map, tex.emissive, 0.55);
  group.add(decalMesh(decal.geo, mat, `target:${zone.id}`));
  geos.push(decal.geo);
  mats.push(mat);
}

/* ------------------------------------------------------------------ */
/* Trigger zones (RELEASE etc.)                                         */
/* ------------------------------------------------------------------ */

function buildTrigger(group: Group, zone: ZoneDef, probe: SurfaceProbe, geos: BufferGeometry[], mats: Material[]): void {
  const [hx, , hz] = zone.halfSize;
  const decal = conformedDecal(zone, probe, 24, Math.max(8, Math.min(48, Math.round(hz / 1.5))), 1);
  if (!decal) {
    // aerial trigger: a slim frame reads better than nothing
    buildCheckpoint(group, zone, geos);
    return;
  }
  const mat = decalMaterial(null, null, 0.6);
  const mesh = decalMesh(decal.geo, mat, `trigger:${zone.id}`);
  // artwork needs the display font: hidden until drawn (a decal without texture would be a white sheet)
  mesh.visible = false;
  group.add(mesh);
  geos.push(decal.geo);
  mats.push(mat);
  const deckFraction = Math.min(1, decal.centerHit.halfWidth / Math.max(0.01, hx));
  // Not cancelled on dispose (StrictMode re-mounts reuse the build); dispose() frees the textures if present.
  void ensureFonts().then(() => {
    const art = drawZoneBand({ label: zone.label, aspect: hz / Math.max(0.01, hx), deckFraction });
    mat.map = art.map;
    mat.emissiveMap = art.emissive;
    mat.userData.ownedTextures = [art.map, art.emissive];
    mat.needsUpdate = true;
    mesh.visible = true;
  });
}

/* ------------------------------------------------------------------ */
/* Finish arch                                                          */
/* ------------------------------------------------------------------ */

export interface ArchSpec {
  /** Inner clear span between the legs (m). */
  span: number;
  /** Clear height under the beam (m). */
  height: number;
  /** Leg section across / along (m). */
  legWidth: number;
  legDepth: number;
  /** Beam height (m). */
  beamHeight: number;
  /** How far the legs continue below y = 0 (m). */
  legsBelow: number;
}

export interface ArchParts {
  graphite: GeoBuilder;
  warmWhite: GeoBuilder;
  glow: GeoBuilder;
  /** Center of the beam's front (+z) face and its size, for the lettering panel. */
  panel: { center: Vector3; width: number; height: number };
}

/**
 * Arch geometry in local space: opening centered on x = 0, ground at y = 0, the arch plane is XY,
 * the front faces +z (towards the approaching car when placed facing it).
 */
export function buildArchParts(spec: ArchSpec): ArchParts {
  const graphite = new GeoBuilder();
  const warmWhite = new GeoBuilder();
  const glow = new GeoBuilder();
  const { span, height, legWidth: lw, legDepth: ld, beamHeight: bh, legsBelow } = spec;
  const legX = span / 2 + lw / 2;
  const top = height + bh;
  for (const side of [-1, 1]) {
    const m = new Matrix4().makeTranslation(side * legX, 0, 0);
    // obelisk legs: broad at deck level, slimmer at the beam, tapering to a point-ish end below
    const prof = chamferRect(lw / 2, ld / 2, lw * 0.14);
    taperedPrism(graphite, prof, -legsBelow, 0, [0.35, 0.35], [1.15, 1.08], { matrix: m });
    taperedPrism(graphite, prof, 0, top, [1.15, 1.08], [0.9, 0.95], { matrix: m, capTop: true });
    // vertical cyan light strip on the inner face of each leg
    const inner = side * (legX - lw / 2 - 0.02);
    const strip = new Matrix4().makeTranslation(inner, 0, 0);
    taperedPrism(glow, chamferRect(0.06, 0.12, 0), 0.6, height - 0.3, [1, 1], [1, 1], { matrix: strip, capTop: true, capBottom: true });
  }
  // beam: warm white, slightly deeper than the legs, with a recessed underside light bar
  const beamW = span + lw * 2 + 1.2;
  const beamD = ld * 1.15;
  const bm = new Matrix4().makeTranslation(0, height + bh / 2, 0);
  taperedPrism(warmWhite, chamferRect(beamW / 2, beamD / 2, 0.18), -bh / 2, bh / 2, [1, 1], [1, 1], {
    matrix: bm,
    capTop: true,
    capBottom: true,
  });
  const lightBar = new Matrix4().makeTranslation(0, height - 0.06, 0);
  taperedPrism(glow, chamferRect(span / 2 - 0.4, 0.22, 0), 0, 0.14, [1, 1], [1, 1], { matrix: lightBar, capTop: true, capBottom: true });
  return {
    graphite,
    warmWhite,
    glow,
    panel: { center: new Vector3(0, height + bh / 2, beamD / 2 + 0.03), width: beamW * 0.7, height: bh * 0.66 },
  };
}

function buildFinishArch(
  group: Group,
  zone: ZoneDef,
  probe: SurfaceProbe,
  geos: BufferGeometry[],
  mats: Material[],
): void {
  const lib = getLevelMaterials();
  const { center, up, forward } = zoneFrame(zone);
  const [hx, hy, hz] = zone.halfSize;
  // the arch stands at the far (forward) end of the zone, on the deck
  const at = center.clone().addScaledVector(forward, hz);
  const hit = probe.probe(at.clone().addScaledVector(up, hy + 2), hy * 2 + 40, 3);
  const base = hit ? hit.point : at.clone().addScaledVector(up, -hy);
  // ribbons: legs clear the whole deck; box decks (platforms, arenas — possibly hundreds of
  // meters wide): the arch spans the zone, not the platform
  const deckHw = hit && !hit.box ? hit.halfWidth : hx;
  const span = Math.max(hx, deckHw) * 2 + 3;
  const parts = buildArchParts({
    span,
    height: Math.max(13, span * 0.42),
    legWidth: 3.0,
    legDepth: 4.0,
    beamHeight: 4.6,
    // beside a ribbon the legs plunge past the slab; on a platform they stand on it
    legsBelow: hit?.box ? 0.01 : 40,
  });
  // orient: arch front (+z local) faces the approaching car (i.e. -forward); keep it upright
  // rotation about Y maps local +z to (sin a, 0, cos a); we want it along -forward
  const fwdFlat = new Vector3(forward.x, 0, forward.z).normalize();
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.atan2(-fwdFlat.x, -fwdFlat.z));
  const root = new Group();
  root.name = `finish:${zone.id}`;
  root.position.copy(base);
  root.quaternion.copy(q);
  const add = (b: GeoBuilder, mat: Material, cast: boolean) => {
    if (b.isEmpty()) return;
    const g = b.build();
    const mesh = new Mesh(g, mat);
    mesh.castShadow = cast;
    mesh.receiveShadow = cast;
    root.add(mesh);
    geos.push(g);
  };
  // monolithic warm white arch; graphite is reserved for the lettering band
  add(parts.graphite, lib.warmWhite, true);
  add(parts.warmWhite, lib.warmWhite, true);
  add(parts.glow, lib.glow.cyan, false);

  // lettering panel (texture drawn once fonts are ready)
  const panelGeo = new PlaneGeometry(1, 1);
  const panelMat = new MeshStandardMaterial({
    color: PALETTE.graphite800,
    roughness: 0.35,
    metalness: 0.4,
    emissive: '#ffffff',
    emissiveIntensity: 0,
    side: DoubleSide,
  });
  const panel = new Mesh(panelGeo, panelMat);
  panel.position.copy(parts.panel.center);
  panel.scale.set(parts.panel.width, parts.panel.height, 1);
  root.add(panel);
  geos.push(panelGeo);
  mats.push(panelMat);
  // Not cancelled on dispose (StrictMode re-mounts reuse the build); dispose() frees it if present.
  void ensureFonts().then(() => {
    const label = drawLabel({
      text: zone.label ?? 'FINISH',
      fontPx: 170,
      trackingEm: 0.5,
      padEm: 0.9,
      background: PALETTE.graphite800,
      rule: PALETTE.cyan,
    });
    panelMat.map = label.texture;
    panelMat.emissiveMap = label.texture;
    panelMat.emissiveIntensity = 0.65;
    panelMat.color.set('#ffffff');
    panelMat.userData.ownedTextures = [label.texture];
    panelMat.needsUpdate = true;
    panel.scale.set(parts.panel.height * label.aspect, parts.panel.height, 1);
  });
  group.add(root);
}

/* ------------------------------------------------------------------ */
/* Gates                                                                */
/* ------------------------------------------------------------------ */

/** Ring gate parts in local space (ring in the XY plane, centered at the origin). */
export function buildRingParts(radius: number, tube: number): { titanium: GeoBuilder; glow: GeoBuilder; graphite: GeoBuilder } {
  const titanium = new GeoBuilder();
  const glow = new GeoBuilder();
  const graphite = new GeoBuilder();
  const segs = Math.max(48, Math.round(radius * 6));
  const outer = new TorusGeometry(radius, tube, 10, segs);
  titanium.append(outer);
  outer.dispose();
  const inner = new TorusGeometry(radius - tube * 0.95, tube * 0.28, 8, segs);
  glow.append(inner);
  inner.dispose();
  // four node housings
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2 + Math.PI / 4;
    const m = new Matrix4().makeRotationZ(a).setPosition(Math.cos(a) * radius, Math.sin(a) * radius, 0);
    taperedPrism(graphite, chamferRect(tube * 1.6, tube * 1.6, tube * 0.4), -tube * 2.2, tube * 2.2, [1, 1], [1, 1], {
      matrix: m,
      capTop: true,
      capBottom: true,
    });
  }
  return { titanium, glow, graphite };
}

function buildRingGate(group: Group, zone: ZoneDef, geos: BufferGeometry[]): void {
  const lib = getLevelMaterials();
  const { q, center } = zoneFrame(zone);
  const [hx, hy] = zone.halfSize;
  const radius = Math.min(hx, hy);
  const parts = buildRingParts(radius, Math.max(0.22, radius * 0.035));
  const root = new Group();
  root.name = `gate:${zone.id}`;
  root.position.copy(center);
  root.quaternion.copy(q);
  for (const [b, mat] of [
    [parts.titanium, lib.titanium],
    [parts.glow, lib.glow.cyan],
    [parts.graphite, lib.graphite],
  ] as const) {
    const g = b.build();
    const mesh = new Mesh(g, mat);
    mesh.castShadow = mat !== lib.glow.cyan;
    root.add(mesh);
    geos.push(g);
  }
  group.add(root);
}

function buildCheckpoint(group: Group, zone: ZoneDef, geos: BufferGeometry[]): void {
  const lib = getLevelMaterials();
  const { q, center } = zoneFrame(zone);
  const [hx, hy] = zone.halfSize;
  const t = 0.35;
  const frame = new GeoBuilder();
  const glow = new GeoBuilder();
  const bars: [number, number, number, number][] = [
    // cx, cy, sx, sy
    [0, hy + t / 2, hx * 2 + t * 2, t],
    [0, -hy - t / 2, hx * 2 + t * 2, t],
    [-hx - t / 2, 0, t, hy * 2],
    [hx + t / 2, 0, t, hy * 2],
  ];
  for (const [cx, cy, sx, sy] of bars) {
    const m = new Matrix4().makeTranslation(cx, cy, 0);
    taperedPrism(frame, chamferRect(sx / 2, t / 2, t * 0.15), -sy / 2, sy / 2, [1, 1], [1, 1], {
      matrix: m,
      capTop: true,
      capBottom: true,
    });
  }
  // inner glow line (top bar underside)
  taperedPrism(glow, chamferRect(hx - 0.2, 0.06, 0), hy - 0.06, hy, [1, 1], [1, 1], { capTop: true, capBottom: true });
  const root = new Group();
  root.name = `checkpoint:${zone.id}`;
  root.position.copy(center);
  root.quaternion.copy(q);
  for (const [b, mat] of [
    [frame, lib.titanium],
    [glow, lib.glow.cyan],
  ] as const) {
    const g = b.build();
    root.add(new Mesh(g, mat));
    geos.push(g);
  }
  group.add(root);
}
