/**
 * Structural kit pieces: lattice towers & beams, sculpted pylons, monumental arches, cable stays,
 * ring gates and free-form LED strips. Every component is a single <group> whose geometry is
 * merged per material (1–3 draw calls) and disposed on unmount / prop change.
 */
import { CatmullRomCurve3, DoubleSide, Group, Matrix4, Mesh, MeshStandardMaterial, PlaneGeometry, Quaternion, Vector3 } from 'three';
import type { V3 } from '@/game/types';
import { PALETTE } from '@/render/palette';
import { getLevelMaterials, type LedColor } from '../materials';
import { chamferRect, dedupePoints, GeoBuilder, polylineFrames, sweepProfile, taperedPrism, type Vec2 } from '../geometry/GeoBuilder';
import { latticeBeam, latticeTower, MemberBatch, type BracePattern } from '../geometry/truss';
import { addPylon } from '../geometry/supports';
import { buildArchParts, buildRingParts } from '../geometry/zoneMarkers';
import { drawLabel, ensureFonts } from '../textures/textTextures';
import { ledMaterial, meshFrom, useKitBuild, type Disposable, type KitTransform } from './common';

function KitRoot({ t, object }: { t: KitTransform; object: Group }) {
  return (
    <group name={t.name} position={t.position} rotation={t.rotation} scale={t.scale}>
      <primitive object={object} />
    </group>
  );
}

/** LED bar profile (x = right, y = up), CCW looking along the strip. */
function barProfile(w: number, h: number): Vec2[] {
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ];
}

/** Appends an LED bar swept along `points` (rotation-minimizing frames around `up`). */
export function addLedBar(b: GeoBuilder, points: Vector3[], width: number, height: number, up: Vector3 = new Vector3(0, 1, 0)): void {
  const pts = dedupePoints(points);
  if (pts.length < 2) return;
  const { rights, ups } = polylineFrames(pts, up);
  sweepProfile(b, pts, rights, ups, barProfile(width, height), { closed: true, caps: true });
}

/* ------------------------------------------------------------------ */
/* TrussTower                                                           */
/* ------------------------------------------------------------------ */

export interface TrussTowerProps extends KitTransform {
  /** Height (m). Default 40. */
  height?: number;
  /** Footprint along local X / Z (m). Default 8 x 8. */
  width?: number;
  depth?: number;
  /** Panel height (m). Default ~0.75 x footprint. */
  bay?: number;
  legRadius?: number;
  braceRadius?: number;
  /** 'x' (cross-braced, default) or 'zigzag' (lighter Warren look). */
  pattern?: BracePattern;
  /** Top footprint scale (1 = prismatic). */
  taper?: number;
  /** Concrete footing pads under the legs. Default true. */
  footings?: boolean;
  /** Emissive ring around the top (e.g. 'red' for the Level-3 look). */
  topLights?: LedColor | string;
  castShadow?: boolean;
}

/** Four-legged steel lattice tower standing on y = 0 (1 draw call + footings / lights). */
export function TrussTower(props: TrussTowerProps) {
  const {
    height = 40,
    width = 8,
    depth = 8,
    bay,
    legRadius,
    braceRadius,
    pattern = 'x',
    taper = 1,
    footings = true,
    topLights,
    castShadow = true,
  } = props;
  const built = useKitBuild(() => {
    const lib = getLevelMaterials();
    const owned: Disposable[] = [];
    const root = new Group();
    const batch = new MemberBatch();
    const rings = latticeTower(batch, {
      base: new Vector3(0, 0, 0),
      height,
      width,
      depth,
      bay,
      legRadius,
      braceRadius,
      pattern,
      taper,
    });
    const truss = batch.build(lib.steel, castShadow);
    if (truss) {
      root.add(truss);
      owned.push(truss);
    }
    if (footings) {
      const b = new GeoBuilder();
      const pad = Math.max(0.8, Math.min(width, depth) * 0.14);
      for (const c of rings[0]) b.append(boxGeo(pad, 0.6, pad), new Matrix4().makeTranslation(c.x, 0.3, c.z));
      const m = meshFrom(b, lib.pylon, owned);
      if (m) root.add(m);
    }
    if (topLights) {
      const b = new GeoBuilder();
      const top = rings[rings.length - 1].map((p) => p.clone().add(new Vector3(0, 0.15, 0)));
      addLedBar(b, [...top, top[0]], 0.14, 0.1);
      const m = meshFrom(b, ledMaterial(topLights, true, owned), owned, { cast: false, receive: false });
      if (m) root.add(m);
    }
    return { root, owned };
  }, [height, width, depth, bay, legRadius, braceRadius, pattern, taper, footings, topLights, castShadow]);
  return <KitRoot t={props} object={built.root} />;
}

/** Small helper: axis-aligned box geometry centered at the origin (module attribute set). */
function boxGeo(sx: number, sy: number, sz: number) {
  const b = new GeoBuilder();
  taperedPrism(b, chamferRect(sx / 2, sz / 2, 0), -sy / 2, sy / 2, [1, 1], [1, 1], { capTop: true, capBottom: true });
  return b.build();
}

/* ------------------------------------------------------------------ */
/* TrussBeam                                                            */
/* ------------------------------------------------------------------ */

export interface TrussBeamProps extends KitTransform {
  from: V3;
  to: V3;
  /** Cross-section width / height (m). Default 2 x 2. */
  width?: number;
  height?: number;
  /** Up hint for the cross-section. Default world up. */
  up?: V3;
  bay?: number;
  chordRadius?: number;
  braceRadius?: number;
  /** LED strip along the lower chords ('left' | 'right' | 'both' sides). */
  ledColor?: LedColor | string;
  ledSide?: 'left' | 'right' | 'both';
  castShadow?: boolean;
}

/** Straight box truss between two points (centered on the from->to line). */
export function TrussBeam(props: TrussBeamProps) {
  const { from, to, width = 2, height = 2, up, bay, chordRadius, braceRadius, ledColor, ledSide = 'both', castShadow = true } = props;
  const key = JSON.stringify([from, to, up]);
  const built = useKitBuild(() => {
    const lib = getLevelMaterials();
    const owned: Disposable[] = [];
    const root = new Group();
    const a = new Vector3(...from);
    const c = new Vector3(...to);
    const hint = up ? new Vector3(...up) : new Vector3(0, 1, 0);
    const batch = new MemberBatch();
    // latticeBeam puts the chords from 0 to -height below the line offset by +height/2
    latticeBeam(batch, { from: a, to: c, up: hint, width, height, bay, chordRadius, braceRadius });
    const truss = batch.build(lib.steel, castShadow);
    if (truss) {
      root.add(truss);
      owned.push(truss);
    }
    if (ledColor) {
      const dir = new Vector3().subVectors(c, a).normalize();
      let right = new Vector3().crossVectors(dir, hint);
      if (right.lengthSq() < 1e-6) right = new Vector3(1, 0, 0);
      right.normalize();
      const upv = new Vector3().crossVectors(right, dir).normalize();
      const b = new GeoBuilder();
      const sides = ledSide === 'both' ? [-1, 1] : ledSide === 'left' ? [-1] : [1];
      for (const s of sides) {
        const off = right.clone().multiplyScalar(s * (width / 2 + 0.12)).addScaledVector(upv, -height / 2);
        addLedBar(b, [a.clone().add(off), c.clone().add(off)], 0.12, 0.1, upv);
      }
      const m = meshFrom(b, ledMaterial(ledColor, true, owned), owned, { cast: false, receive: false });
      if (m) root.add(m);
    }
    return { root, owned };
  }, [key, width, height, bay, chordRadius, braceRadius, ledColor, ledSide, castShadow]);
  return <KitRoot t={props} object={built.root} />;
}

/* ------------------------------------------------------------------ */
/* Pylon                                                                */
/* ------------------------------------------------------------------ */

export interface PylonProps extends KitTransform {
  /** Shaft length below the head (m). The head top is at the component origin. Default 120. */
  height?: number;
  /** Width of the deck it carries (m) — sizes head and shaft. Default 24. */
  deckWidth?: number;
  /** Heading of the carried deck (deg, 0 = -Z). Default 0. */
  yawDeg?: number;
}

/** The sculpted chalice pylon used by auto supports, for manual placement. Origin = top of head. */
export function Pylon(props: PylonProps) {
  const { height = 120, deckWidth = 24, yawDeg = 0 } = props;
  const built = useKitBuild(() => {
    const owned: Disposable[] = [];
    const root = new Group();
    const b = new GeoBuilder();
    addPylon(b, {
      top: new Vector3(0, 0, 0),
      quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (yawDeg * Math.PI) / 180),
      deckWidth,
      bottomY: -height,
    });
    const m = meshFrom(b, getLevelMaterials().pylon, owned);
    if (m) root.add(m);
    return { root, owned };
  }, [height, deckWidth, yawDeg]);
  return <KitRoot t={props} object={built.root} />;
}

/* ------------------------------------------------------------------ */
/* Arch                                                                 */
/* ------------------------------------------------------------------ */

export interface ArchProps extends KitTransform {
  /** Clear span between legs (m). Default 30. */
  span?: number;
  /** Clear height under the beam (m). Default 14. */
  height?: number;
  legWidth?: number;
  legDepth?: number;
  beamHeight?: number;
  /** Legs continue below y = 0 (m), tapering — for arches standing beside floating decks. Default 0. */
  legsBelow?: number;
  /** Optional lettering on the beam front (+Z), e.g. "START". */
  text?: string;
  /** Underside light bar color. Default 'cyan'. */
  lightColor?: LedColor;
}

/** Monumental warm-white arch; front faces +Z. */
export function Arch(props: ArchProps) {
  const { span = 30, height = 14, legWidth = 3, legDepth = 4, beamHeight = 4.4, legsBelow = 0, text, lightColor = 'cyan' } = props;
  const built = useKitBuild(() => {
    const lib = getLevelMaterials();
    const owned: Disposable[] = [];
    const root = new Group();
    const parts = buildArchParts({ span, height, legWidth, legDepth, beamHeight, legsBelow: Math.max(0.01, legsBelow) });
    for (const [b, mat, cast] of [
      [parts.graphite, lib.warmWhite, true],
      [parts.warmWhite, lib.warmWhite, true],
      [parts.glow, lib.glow[lightColor], false],
    ] as const) {
      const m = meshFrom(b, mat, owned, { cast, receive: cast });
      if (m) root.add(m);
    }
    if (text) {
      const geo = new PlaneGeometry(1, 1);
      const mat = new MeshStandardMaterial({ color: PALETTE.graphite800, roughness: 0.35, metalness: 0.4, side: DoubleSide });
      owned.push(geo, mat);
      const panel = new Mesh(geo, mat);
      panel.position.copy(parts.panel.center);
      panel.scale.set(parts.panel.width, parts.panel.height, 1);
      root.add(panel);
      // Not cancelled on dispose: a StrictMode re-mount reuses this build. If the component is
      // really gone the texture is never uploaded (GC'd with the build).
      void ensureFonts().then(() => {
        const label = drawLabel({ text, fontPx: 170, trackingEm: 0.5, padEm: 0.9, background: PALETTE.graphite800, rule: PALETTE.cyan });
        mat.map = label.texture;
        mat.emissiveMap = label.texture;
        mat.emissive.set('#ffffff');
        mat.emissiveIntensity = 0.65;
        mat.color.set('#ffffff');
        mat.needsUpdate = true;
        owned.push(label.texture);
        panel.scale.set(parts.panel.height * label.aspect, parts.panel.height, 1);
      });
    }
    return { root, owned };
  }, [span, height, legWidth, legDepth, beamHeight, legsBelow, text, lightColor]);
  return <KitRoot t={props} object={built.root} />;
}

/* ------------------------------------------------------------------ */
/* CableStays                                                           */
/* ------------------------------------------------------------------ */

export interface CableStaysProps extends KitTransform {
  /** Top anchor (mast head), local space. */
  anchor: V3;
  /** Deck anchor points, local space. */
  points: V3[];
  /** Cable radius (m). Default 0.09. */
  radius?: number;
  /** Optional sculpted mast from this base point up to the anchor (+8 m above). */
  mastBase?: V3;
  /** Mast half width at the base (m). Default 2.2. */
  mastWidth?: number;
}

/** Fan of steel stay cables from a mast head to deck anchors, with anchor blocks (and optional mast). */
export function CableStays(props: CableStaysProps) {
  const { anchor, points, radius = 0.09, mastBase, mastWidth = 2.2 } = props;
  const key = JSON.stringify([anchor, points, mastBase]);
  const built = useKitBuild(() => {
    const lib = getLevelMaterials();
    const owned: Disposable[] = [];
    const root = new Group();
    const top = new Vector3(...anchor);
    const batch = new MemberBatch();
    const blocks = new GeoBuilder();
    points.forEach((p, i) => {
      const end = new Vector3(...p);
      // spread the cable heads slightly along the mast so they do not converge to one point
      const head = top.clone().add(new Vector3(0, -i * 0.9, 0));
      batch.add(head, end, radius);
      blocks.append(boxGeo(0.6, 0.35, 0.9), new Matrix4().makeTranslation(end.x, end.y, end.z));
    });
    const cables = batch.build(lib.steel, false);
    if (cables) {
      root.add(cables);
      owned.push(cables);
    }
    const mb = meshFrom(blocks, lib.graphite, owned);
    if (mb) root.add(mb);
    if (mastBase) {
      const base = new Vector3(...mastBase);
      const mast = new GeoBuilder();
      const h = top.y + 8 - base.y;
      taperedPrism(mast, chamferRect(mastWidth, mastWidth * 0.7, mastWidth * 0.25), 0, h, [1, 1], [0.45, 0.45], {
        matrix: new Matrix4().makeTranslation(base.x, base.y, base.z),
        capTop: true,
      });
      const m = meshFrom(mast, lib.warmWhite, owned);
      if (m) root.add(m);
    }
    return { root, owned };
  }, [key, radius, mastWidth]);
  return <KitRoot t={props} object={built.root} />;
}

/* ------------------------------------------------------------------ */
/* RingGate                                                             */
/* ------------------------------------------------------------------ */

export interface RingGateProps extends KitTransform {
  /** Ring radius (m). Default 10. */
  radius?: number;
  /** Tube radius (m). Default radius * 0.035. */
  tube?: number;
  /** Inner light ring color. Default 'cyan'. */
  color?: LedColor;
  /** Suspension cables up to this height above the ring top (m); 0 = free-floating. Default 0. */
  cables?: number;
}

/** Slim titanium ring (XY plane, facing ±Z) with an inner light ring and node housings. */
export function RingGate(props: RingGateProps) {
  const { radius = 10, tube, color = 'cyan', cables = 0 } = props;
  const built = useKitBuild(() => {
    const lib = getLevelMaterials();
    const owned: Disposable[] = [];
    const root = new Group();
    const parts = buildRingParts(radius, tube ?? Math.max(0.22, radius * 0.035));
    for (const [b, mat, cast] of [
      [parts.titanium, lib.titanium, true],
      [parts.glow, lib.glow[color], false],
      [parts.graphite, lib.graphite, true],
    ] as const) {
      const m = meshFrom(b, mat, owned, { cast, receive: false });
      if (m) root.add(m);
    }
    if (cables > 0) {
      const batch = new MemberBatch();
      for (const s of [-1, 1]) {
        const a = Math.PI / 2 + s * 0.55;
        const p = new Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0);
        batch.add(p, new Vector3(p.x * 1.6, radius + cables, 0), 0.05);
      }
      const m = batch.build(lib.steel, false);
      if (m) {
        root.add(m);
        owned.push(m);
      }
    }
    return { root, owned };
  }, [radius, tube, color, cables]);
  return <KitRoot t={props} object={built.root} />;
}

/* ------------------------------------------------------------------ */
/* LEDStrip                                                             */
/* ------------------------------------------------------------------ */

export interface LEDStripProps extends KitTransform {
  /** Polyline points (local space), at least 2. */
  points: V3[];
  /** LED color key or any CSS color. Default 'red'. */
  color?: LedColor | string;
  /** Bar cross-section (m). Default 0.14 x 0.08. */
  width?: number;
  height?: number;
  /** Resample through a Catmull-Rom spline (segments per meter). 0 = straight segments. Default 0. */
  smooth?: number;
  closed?: boolean;
  /** Up hint for the bar orientation. Default +Y. */
  up?: V3;
  /** Brightness multiplier (custom material when != 1). */
  intensity?: number;
  /** Discrete LED dot diffuser (default true). */
  dots?: boolean;
  /** Width (m) of an additive light spill on the plane around the strip (e.g. the floor); 0 = none. Default 0. */
  spill?: number;
}

/** Thin emissive LED bar along a polyline (bloom-friendly). */
export function LEDStrip(props: LEDStripProps) {
  const { points, color = 'red', width = 0.14, height = 0.08, smooth = 0, closed = false, up, intensity = 1, dots = true, spill = 0 } = props;
  const key = JSON.stringify([points, up]);
  const built = useKitBuild(() => {
    const owned: Disposable[] = [];
    const root = new Group();
    // coincident points (e.g. a loop that already repeats its first point) would break the sweep
    let pts = dedupePoints(points.map((p) => new Vector3(...p)));
    if (closed && pts.length > 2 && pts[0].distanceToSquared(pts[pts.length - 1]) < 1e-8) pts.pop();
    if (closed && pts.length > 2) pts.push(pts[0].clone());
    if (smooth > 0 && pts.length > 2) {
      const curve = new CatmullRomCurve3(closed ? pts.slice(0, -1) : pts, closed, 'centripetal');
      const n = Math.max(8, Math.round(curve.getLength() * smooth));
      pts = dedupePoints(curve.getSpacedPoints(n));
    }
    const b = new GeoBuilder();
    const upHint = up ? new Vector3(...up) : new Vector3(0, 1, 0);
    addLedBar(b, pts, width, height, upHint);
    const m = meshFrom(b, ledMaterial(color, dots, owned, intensity), owned, { cast: false, receive: false });
    if (m) root.add(m);
    if (spill > 0 && pts.length > 1) {
      // falloff strip on the plane under the bar, both sides (vertex colors), additive
      const { rights, ups } = polylineFrames(pts, upHint);
      const sb = new GeoBuilder().withColors();
      const rows: [number, number][] = [
        [-spill, 0],
        [-spill * 0.45, 0.14],
        [-spill * 0.18, 0.45],
        [0, 1],
        [spill * 0.18, 0.45],
        [spill * 0.45, 0.14],
        [spill, 0],
      ];
      const ids: number[][] = [];
      const p = new Vector3();
      pts.forEach((q, i) => {
        ids.push(
          rows.map(([off, k]) => {
            p.copy(q).addScaledVector(rights[i], off).addScaledVector(ups[i], -height / 2 + 0.01);
            const id = sb.vertex(p, ups[i], i, off);
            sb.color(k, k, k);
            return id;
          }),
        );
      });
      for (let i = 0; i < pts.length - 1; i++) for (let r = 0; r < rows.length - 1; r++) sb.quad(ids[i][r], ids[i][r + 1], ids[i + 1][r + 1], ids[i + 1][r]);
      const lib = getLevelMaterials();
      const tint = (color in lib.spill ? color : 'white') as LedColor;
      const sm = meshFrom(sb, lib.spill[tint], owned, { cast: false, receive: false });
      if (sm) {
        sm.renderOrder = 1;
        root.add(sm);
      }
    }
    return { root, owned };
  }, [key, color, width, height, smooth, closed, intensity, dots, spill]);
  return <KitRoot t={props} object={built.root} />;
}
