/**
 * Architectural kit pieces: grandstands, panelled monoliths, facility billboards and the
 * underside of floating platforms (FacilityBase). Merged per material, disposed on change.
 */
import { useEffect } from 'react';
import { CylinderGeometry, Group, Matrix4, Mesh, MeshStandardMaterial, PlaneGeometry, TorusGeometry, Vector3 } from 'three';
import type { V3 } from '@/game/types';
import { PALETTE } from '@/render/palette';
import { getLevelMaterials, type LedColor } from '../materials';
import { chamferRect, GeoBuilder, loftSections, taperedPrism, type Vec2 } from '../geometry/GeoBuilder';
import { extrudeXY } from '../geometry/supports';
import { drawBillboard, ensureFonts } from '../textures/textTextures';
import { getCladdingMaterial, type CladdingVariant } from './kitMaterials';

import { ledMaterial, meshFrom, useKitBuild, type Disposable, type KitTransform } from './common';

function KitRoot({ t, object }: { t: KitTransform; object: Group }) {
  return (
    <group name={t.name} position={t.position} rotation={t.rotation} scale={t.scale}>
      <primitive object={object} />
    </group>
  );
}

const box = (b: GeoBuilder, sx: number, sy: number, sz: number, x: number, y: number, z: number, chamfer = 0, m?: Matrix4) =>
  taperedPrism(b, chamferRect(sx / 2, sz / 2, chamfer), -sy / 2, sy / 2, [1, 1], [1, 1], {
    matrix: (m ? m.clone() : new Matrix4()).multiply(new Matrix4().makeTranslation(x, y, z)),
    capTop: true,
    capBottom: true,
  });

/* ------------------------------------------------------------------ */
/* Grandstand                                                           */
/* ------------------------------------------------------------------ */

export interface GrandstandProps extends KitTransform {
  /** Length along X (m). Default 60. */
  length?: number;
  /** Seating rows. Default 14. */
  rows?: number;
  /** Row tread depth / riser height (m). Default 0.9 / 0.42. */
  rowDepth?: number;
  rowHeight?: number;
  /** Podium height under the first row (m). Default 2.4. */
  baseHeight?: number;
  /** Accent LEDs along the tier nosings (null = none). Default 'red'. */
  accent?: LedColor | string | null;
  /** Put an accent strip on every Nth row. Default 2. */
  accentEvery?: number;
  /** Cantilevered canopy with downlights. Default true. */
  roof?: boolean;
  /** 'dark' graphite tiers (night arena) or 'concrete'. Default 'dark'. */
  variant?: 'dark' | 'concrete';
}

/** Stepped spectator stand facing +Z (tiers rise towards -Z), red tier LEDs, optional canopy. */
export function Grandstand(props: GrandstandProps) {
  const {
    length = 60,
    rows = 14,
    rowDepth = 0.9,
    rowHeight = 0.42,
    baseHeight = 2.4,
    accent = 'red',
    accentEvery = 2,
    roof = true,
    variant = 'dark',
  } = props;
  const built = useKitBuild(() => {
    const lib = getLevelMaterials();
    const owned: Disposable[] = [];
    const root = new Group();
    const L = length;
    const depthTotal = rows * rowDepth;
    const yRow = (i: number) => baseHeight + (i + 1) * rowHeight;
    // stepped mass: staircase profile in (z, y), extruded along X (end faces hidden by side walls)
    const prof: Vec2[] = [[0, 0]];
    prof.push([0, yRow(0)]);
    for (let i = 0; i < rows; i++) {
      prof.push([-(i + 1) * rowDepth, yRow(i)]);
      if (i < rows - 1) prof.push([-(i + 1) * rowDepth, yRow(i + 1)]);
    }
    prof.push([-depthTotal, 0]);
    const mass = new GeoBuilder();
    for (let k = 0; k < prof.length; k++) {
      const [z0, y0] = prof[k];
      const [z1, y1] = prof[(k + 1) % prof.length];
      // walking the profile CCW in (z, y) seen from +X; quad faces outward
      mass.flatQuad(new Vector3(L / 2, y0, z0), new Vector3(L / 2, y1, z1), new Vector3(-L / 2, y1, z1), new Vector3(-L / 2, y0, z0));
    }
    const tierMat = variant === 'dark' ? lib.graphiteMatte : lib.sideConcrete;
    const mm = meshFrom(mass, tierMat, owned);
    if (mm) root.add(mm);
    // seat backs (continuous rails) + LED nosings
    const seats = new GeoBuilder();
    const leds = new GeoBuilder();
    for (let i = 0; i < rows; i++) {
      const zf = -i * rowDepth;
      box(seats, L - 0.4, 0.42, 0.1, 0, yRow(i) + 0.21, zf - rowDepth + 0.18);
      if (accent && i % accentEvery === 0) box(leds, L - 0.2, 0.05, 0.06, 0, yRow(i) - 0.035, zf + 0.035);
    }
    const sm = meshFrom(seats, lib.graphite, owned);
    if (sm) root.add(sm);
    if (accent) {
      const lm = meshFrom(leds, ledMaterial(accent, true, owned), owned, { cast: false, receive: false });
      if (lm) root.add(lm);
    }
    // side walls (warm white) + canopy + columns
    const white = new GeoBuilder();
    const wallTop = yRow(rows - 1) + 1.2;
    const wall: Vec2[] = [
      [0.8, 0],
      [0.8, yRow(0) + 1.2],
      [-depthTotal - 0.4, wallTop],
      [-depthTotal - 0.4, 0],
    ];
    for (const s of [-1, 1]) {
      // local (x, y) = (world z, y); extrusion along local z -> world -x
      const m = new Matrix4().makeTranslation(s * (L / 2 + 0.3), 0, 0).multiply(new Matrix4().makeRotationY(-Math.PI / 2));
      extrudeXY(white, wall, -0.3, 0.3, m);
    }
    const lamps = new GeoBuilder();
    if (roof) {
      const roofY = wallTop + 6;
      const roofD = depthTotal * 0.75 + 1;
      const zBack = -depthTotal - 1.2;
      box(white, L + 2, 0.7, roofD, 0, roofY, zBack + roofD / 2, 0.15);
      const cols = Math.max(2, Math.round(L / 15) + 1);
      for (let c = 0; c < cols; c++) {
        const x = -L / 2 + (c * L) / (cols - 1);
        box(white, 0.8, roofY, 0.8, x, roofY / 2, zBack, 0.12);
      }
      const disc = new CylinderGeometry(0.28, 0.28, 0.08, 14);
      const n = Math.round(L / 4);
      for (let i = 0; i < n; i++) {
        const x = -L / 2 + 2 + (i * (L - 4)) / Math.max(1, n - 1);
        lamps.append(disc, new Matrix4().makeTranslation(x, roofY - 0.39, zBack + roofD * 0.7));
      }
      disc.dispose();
    }
    const wm = meshFrom(white, lib.warmWhite, owned);
    if (wm) root.add(wm);
    const lpm = meshFrom(lamps, lib.lamp, owned, { cast: false, receive: false });
    if (lpm) root.add(lpm);
    return { root, owned };
  }, [length, rows, rowDepth, rowHeight, baseHeight, accent, accentEvery, roof, variant]);
  return <KitRoot t={props} object={built.root} />;
}

/* ------------------------------------------------------------------ */
/* Monolith                                                             */
/* ------------------------------------------------------------------ */

export interface MonolithProps extends KitTransform {
  /** [width, height, depth] (m). Default [24, 96, 24]. Base at y = 0. */
  size?: V3;
  /** Cladding: 'warm' white or 'graphite'. Default 'warm'. */
  variant?: CladdingVariant;
  /** Emissive vertical seams per face. Default 1. */
  seams?: number;
  /** Horizontal emissive bands near the crown. Default 1. */
  bands?: number;
  seamColor?: LedColor | string;
  /** Extend the body below y = 0 (m), e.g. to plunge into the cloud sea. Default 0. */
  below?: number;
}

/** Panelled megastructure with a recessed graphite crown and thin emissive seams. */
export function Monolith(props: MonolithProps) {
  const { size = [24, 96, 24], variant = 'warm', seams = 1, bands = 1, seamColor = 'cyan', below = 0 } = props;
  const [w, h, d] = size;
  const built = useKitBuild(() => {
    const owned: Disposable[] = [];
    const root = new Group();
    const c = Math.min(w, d) * 0.05;
    const crownH = Math.min(8, h * 0.06);
    const body = new GeoBuilder();
    taperedPrism(body, chamferRect(w / 2, d / 2, c), -below, h - crownH, [1, 1], [1, 1], { capBottom: below > 0 });
    // crown: a deep recessed shadow gap (dark) under a slightly proud cap in the same cladding
    const gap = new GeoBuilder();
    const inset = Math.min(0.9, w * 0.03);
    taperedPrism(gap, chamferRect(w / 2 - inset, d / 2 - inset, c), h - crownH, h - crownH + 0.6, [1, 1], [1, 1]);
    taperedPrism(body, chamferRect(w / 2 + 0.15, d / 2 + 0.15, c), h - crownH + 0.6, h, [1, 1], [1, 1], { capTop: true });
    const bm = meshFrom(body, getCladdingMaterial(variant), owned);
    if (bm) root.add(bm);
    const gm0 = meshFrom(gap, getLevelMaterials().graphiteMatte, owned);
    if (gm0) root.add(gm0);
    // seams
    const glow = new GeoBuilder();
    const faces: { n: Vector3; t: Vector3; half: number; off: number }[] = [
      { n: new Vector3(0, 0, 1), t: new Vector3(1, 0, 0), half: w / 2 - c, off: d / 2 },
      { n: new Vector3(0, 0, -1), t: new Vector3(-1, 0, 0), half: w / 2 - c, off: d / 2 },
      { n: new Vector3(1, 0, 0), t: new Vector3(0, 0, -1), half: d / 2 - c, off: w / 2 },
      { n: new Vector3(-1, 0, 0), t: new Vector3(0, 0, 1), half: d / 2 - c, off: w / 2 },
    ];
    const seamTop = h - crownH - 2;
    const seamBottom = Math.max(-below, 0) + 1.5;
    for (const f of faces) {
      for (let s = 0; s < seams; s++) {
        // asymmetric placement reads more architectural than dead center
        const u = seams === 1 ? 0.28 : (s + 1) / (seams + 1) - 0.5;
        const p = f.n.clone().multiplyScalar(f.off + 0.02).addScaledVector(f.t, u * f.half * 2);
        const m = new Matrix4().makeBasis(f.t, new Vector3(0, 1, 0), f.n).setPosition(p.x, 0, p.z);
        box(glow, 0.14, seamTop - seamBottom, 0.06, 0, (seamTop + seamBottom) / 2, 0, 0, m);
      }
      for (let k = 0; k < bands; k++) {
        const y = h - crownH - 1.2 - k * 2.2;
        const p = f.n.clone().multiplyScalar(f.off + 0.02);
        const m = new Matrix4().makeBasis(f.t, new Vector3(0, 1, 0), f.n).setPosition(p.x, 0, p.z);
        box(glow, f.half * 2, 0.12, 0.06, 0, y, 0, 0, m);
      }
    }
    const gm = meshFrom(glow, ledMaterial(seamColor, false, owned), owned, { cast: false, receive: false });
    if (gm) root.add(gm);
    return { root, owned };
  }, [w, h, d, variant, seams, bands, seamColor, below]);
  return <KitRoot t={props} object={built.root} />;
}

/* ------------------------------------------------------------------ */
/* Billboard                                                            */
/* ------------------------------------------------------------------ */

export interface BillboardProps extends KitTransform {
  text: string;
  subtitle?: string;
  /** Small right-aligned tag (e.g. "01", "500 M"). */
  tag?: string;
  /** Board width / height (m). Default 18 x 5. */
  width?: number;
  height?: number;
  /** Height of the board's bottom edge above y = 0 on two posts; 0 = no posts. Default 6. */
  postHeight?: number;
  /** Accent color (CSS). Default cyan. */
  accent?: string;
  /** Face self-illumination. Default 0.85. */
  emissive?: number;
}

/** Dark-glass facility sign with tracked Michroma lettering on slim graphite posts; face +Z. */
export function Billboard(props: BillboardProps) {
  const { text, subtitle, tag, width = 18, height = 5, postHeight = 6, accent = PALETTE.cyan, emissive = 0.85 } = props;
  const built = useKitBuild(() => {
    const lib = getLevelMaterials();
    const owned: Disposable[] = [];
    const root = new Group();
    const depth = 0.5;
    const yc = postHeight + height / 2;
    const frame = new GeoBuilder();
    box(frame, width + 0.3, height + 0.3, depth, 0, yc, 0, 0.08);
    if (postHeight > 0) {
      for (const s of [-1, 1]) {
        taperedPrism(frame, chamferRect(0.35, 0.35, 0.1), 0, postHeight + 0.2, [1.25, 1.25], [1, 1], {
          matrix: new Matrix4().makeTranslation(s * width * 0.3, 0, -depth * 0.1),
          capTop: true,
        });
      }
    }
    const fm = meshFrom(frame, lib.graphite, owned);
    if (fm) root.add(fm);
    const trim = new GeoBuilder();
    for (const y of [yc + height / 2 + 0.2, yc - height / 2 - 0.2]) box(trim, width + 0.5, 0.1, depth + 0.1, 0, y, 0);
    const tm = meshFrom(trim, lib.titanium, owned);
    if (tm) root.add(tm);
    const geo = new PlaneGeometry(width, height);
    const mat = new MeshStandardMaterial({ color: PALETTE.graphite800, roughness: 0.18, metalness: 0.3, emissive: '#ffffff', emissiveIntensity: 0 });
    owned.push(geo, mat);
    const face = new Mesh(geo, mat);
    face.position.set(0, yc, depth / 2 + 0.012);
    root.add(face);
    return { root, owned, mat };
  }, [width, height, postHeight]);
  // face texture (needs fonts) — applied in an effect so StrictMode re-mounts redraw it
  useEffect(() => {
    let alive = true;
    let tex: ReturnType<typeof drawBillboard> | null = null;
    void ensureFonts().then(() => {
      if (!alive) return;
      tex = drawBillboard({ title: text, subtitle, tag, accent, aspect: width / height });
      const m = built.mat;
      m.map = tex;
      m.emissiveMap = tex;
      m.emissiveIntensity = emissive;
      m.color.set('#ffffff');
      m.needsUpdate = true;
    });
    return () => {
      alive = false;
      tex?.dispose();
    };
  }, [built, text, subtitle, tag, accent, width, height, emissive]);
  return <KitRoot t={props} object={built.root} />;
}

/* ------------------------------------------------------------------ */
/* FacilityBase                                                         */
/* ------------------------------------------------------------------ */

export interface FacilityBaseProps extends KitTransform {
  /** Top footprint [width, depth] (m) — match the platform above. Default [120, 120]. */
  size?: [number, number];
  /** Total depth below y = 0 (m). Default 46. */
  depth?: number;
  /** Stepped tiers. Default 3. */
  steps?: number;
  /** Footprint scale at the bottom. Default 0.32. */
  bottomScale?: number;
  /** Downlights on the soffits. Default true. */
  lights?: boolean;
  /** Core ring light color. Default 'cyan'. */
  coreColor?: LedColor;
}

/** Underside of a giant floating platform: stepped panelled soffits, downlights, glowing keel ring. */
export function FacilityBase(props: FacilityBaseProps) {
  const { size = [120, 120], depth = 46, steps = 3, bottomScale = 0.32, lights = true, coreColor = 'cyan' } = props;
  const [w, d] = size;
  const built = useKitBuild(() => {
    const lib = getLevelMaterials();
    const owned: Disposable[] = [];
    const root = new Group();
    const warm = new GeoBuilder();
    const dark = new GeoBuilder();
    const lamps = new GeoBuilder();
    const prof = chamferRect(w / 2, d / 2, Math.min(w, d) * 0.14);
    const tierH = depth / steps;
    const disc = new CylinderGeometry(0.45, 0.45, 0.12, 16);
    for (let k = 0; k < steps; k++) {
      const s0 = 1 - (k * (1 - bottomScale)) / steps;
      const s1 = 1 - ((k + 1) * (1 - bottomScale)) / steps;
      const yTop = -k * tierH;
      const band = tierH * 0.22;
      // vertical fascia band (brushed titanium) then sloped soffit (warm) — separate lofts keep the crease crisp
      loftSections(dark, prof, [
        { y: yTop - band, sx: s0, sz: s0 },
        { y: yTop, sx: s0, sz: s0 },
      ]);
      loftSections(warm, prof, [
        { y: yTop - tierH, sx: s1, sz: s1 },
        { y: yTop - band, sx: s0, sz: s0 },
      ]);
      if (lights) {
        // downlights along the soffit mid-line
        const sm = (s0 + s1) / 2;
        const ym = yTop - band - (tierH - band) / 2;
        const n = prof.length;
        for (let e = 0; e < n; e++) {
          const [x0, z0] = prof[e];
          const [x1, z1] = prof[(e + 1) % n];
          const len = Math.hypot(x1 - x0, z1 - z0) * sm;
          const count = Math.floor(len / 9);
          for (let i = 0; i < count; i++) {
            const t = (i + 0.5) / count;
            const x = (x0 + (x1 - x0) * t) * sm * 0.985;
            const z = (z0 + (z1 - z0) * t) * sm * 0.985;
            // tilt the disc to the soffit slope (normal points down/outward)
            const out = new Vector3(z1 - z0, 0, -(x1 - x0)).normalize();
            const slope = Math.atan2((s0 - s1) * Math.max(w, d) * 0.5, tierH - band);
            const nrm = out.clone().multiplyScalar(Math.cos(slope)).add(new Vector3(0, -Math.sin(slope), 0)).normalize();
            const q = new Matrix4().lookAt(new Vector3(), nrm, new Vector3(0, 1, 0));
            const m = new Matrix4().makeTranslation(x, ym, z).multiply(q).multiply(new Matrix4().makeRotationX(Math.PI / 2));
            lamps.append(disc, m);
          }
        }
      }
    }
    disc.dispose();
    // bottom plate + keel
    const sb = bottomScale;
    taperedPrism(warm, prof, -depth - 0.01, -depth, [sb, sb], [sb, sb], { capBottom: true });
    const keelR = Math.min(w, d) * sb * 0.28;
    taperedPrism(dark, chamferRect(keelR, keelR, keelR * 0.4), -depth - tierH * 0.6, -depth, [0.7, 0.7], [1, 1], { capBottom: true });
    const wm = meshFrom(warm, getCladdingMaterial('warm'), owned);
    if (wm) root.add(wm);
    const dm = meshFrom(dark, lib.titanium, owned);
    if (dm) root.add(dm);
    const lm = meshFrom(lamps, lib.lamp, owned, { cast: false, receive: false });
    if (lm) root.add(lm);
    // keel ring light
    const ringB = new GeoBuilder();
    const ring = new TorusGeometry(keelR * 1.05, 0.22, 8, 64);
    ring.rotateX(Math.PI / 2);
    ringB.append(ring, new Matrix4().makeTranslation(0, -depth - 0.3, 0));
    ring.dispose();
    const rm = meshFrom(ringB, lib.glow[coreColor], owned, { cast: false, receive: false });
    if (rm) root.add(rm);
    return { root, owned };
  }, [w, d, depth, steps, bottomScale, lights, coreColor]);
  return <KitRoot t={props} object={built.root} />;
}
