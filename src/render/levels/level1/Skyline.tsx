/**
 * Structures around and beyond the course (render only):
 *  - StayMasts: needle masts rising from the cloud sea beside a deck, with cable-stay fans down to
 *    its edges (never above the drive surface)
 *  - Facility: the monumental test facility far beyond the finish deck — a floating platform
 *    (stepped underside, downlights, keel ring) carrying a long vaulted hall with a dark-glass end
 *    facade and a slender control tower with an observation crown
 *  - Needles: very slender far masts in the cloud sea (scale and depth without clutter)
 */
import { Group, Matrix4, Vector3 } from 'three';
import type { V3 } from '@/game/types';
import { CableStays, FacilityBase, getCladdingMaterial, getLevelMaterials, Pylon } from '@/render/level';
import { chamferRect, GeoBuilder, loftSections, sweepProfile, taperedPrism, type Vec2 } from '@/render/level/geometry/GeoBuilder';
import { Beacons, type Beacon } from './Markers';
import { meshOf, useBuilt, type Disposable } from './useBuilt';

export interface StayMast {
  /** Mast axis (x, z), foot height and head height (world). */
  x: number;
  z: number;
  foot: number;
  head: number;
  /** Deck anchor points (world, on the slab fascia). */
  anchors: V3[];
}

export function StayMasts({ masts }: { masts: StayMast[] }) {
  return (
    <group name="l1-stay-masts">
      {masts.map((m, i) => (
        <CableStays key={i} anchor={[m.x, m.head, m.z]} points={m.anchors} mastBase={[m.x, m.foot, m.z]} mastWidth={1.9} radius={0.1} />
      ))}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Facility                                                            */
/* ------------------------------------------------------------------ */

/** Barrel-vault cross-section (x across, y up), CCW seen looking along +forward. */
function vaultProfile(halfW: number, wallH: number, rise: number, segs = 14): Vec2[] {
  const pts: Vec2[] = [
    [-halfW, 0],
    [halfW, 0],
    [halfW, wallH],
  ];
  for (let i = 1; i < segs; i++) {
    const a = (i / segs) * Math.PI;
    pts.push([Math.cos(a) * halfW, wallH + Math.sin(a) * rise]);
  }
  pts.push([-halfW, wallH]);
  return pts;
}

export function Facility({ position }: { position: V3 }) {
  const [px, py, pz] = position;
  const built = useBuilt(() => {
    const lib = getLevelMaterials();
    const owned: Disposable[] = [];
    const root = new Group();
    root.name = 'l1-facility-buildings';
    const warm = new GeoBuilder();
    const dark = new GeoBuilder();
    const glass = new GeoBuilder();
    const glow = new GeoBuilder();

    // --- vaulted hall along the course axis (facade toward +Z, the approaching course) ---
    const hallLen = 170;
    const hallHalfW = 34;
    const hallX = 18;
    const hallZ0 = 40; // facade (local z)
    const prof = vaultProfile(hallHalfW, 12, 24);
    const along = [new Vector3(hallX, 0, hallZ0), new Vector3(hallX, 0, hallZ0 - hallLen)];
    // path toward −Z: right = +X (same convention as polylineFrames: right = tangent × up)
    const rights = along.map(() => new Vector3(1, 0, 0));
    const ups = along.map(() => new Vector3(0, 1, 0));
    sweepProfile(warm, along, rights, ups, prof, { closed: true, caps: false });
    // facade: warm end wall with a tall glazed bay (dark glass in a graphite frame) + cyan light band
    const facadeM = new Matrix4().makeTranslation(hallX, 0, hallZ0 + 0.05);
    const facade = new GeoBuilder();
    for (let i = 0; i < prof.length; i++) {
      // fan triangles from the base center (convex profile)
      const [x0, y0] = prof[i];
      const [x1, y1] = prof[(i + 1) % prof.length];
      facade.flatTri(new Vector3(0, 6, 0).applyMatrix4(facadeM), new Vector3(x0, y0, 0).applyMatrix4(facadeM), new Vector3(x1, y1, 0).applyMatrix4(facadeM));
    }
    warm.append(facade.build());
    const bay = new Matrix4().makeTranslation(hallX, 0, hallZ0 + 0.35);
    taperedPrism(dark, chamferRect(hallHalfW * 0.56, 0.3, 0), 1.5, 27, [1, 1], [0.78, 0.78], { matrix: bay, capTop: true });
    taperedPrism(glass, chamferRect(hallHalfW * 0.52, 0.32, 0), 2.2, 26, [1, 1], [0.78, 0.78], { matrix: bay.clone().multiply(new Matrix4().makeTranslation(0, 0, 0.05)), capTop: true });
    // ribs over the vault (every 17 m)
    for (let z = hallZ0 - 8; z > hallZ0 - hallLen; z -= 17) {
      const ribPts = [new Vector3(hallX, 0, z), new Vector3(hallX, 0, z - 1.4)];
      const ribProf = vaultProfile(hallHalfW + 0.5, 12, 24.6);
      sweepProfile(dark, ribPts, ribPts.map(() => new Vector3(1, 0, 0)), ribPts.map(() => new Vector3(0, 1, 0)), ribProf, { closed: true, caps: true });
    }

    // --- control tower with observation crown ---
    const tx = -74;
    const tz = -10;
    const tm = new Matrix4().makeTranslation(tx, 0, tz);
    const shaft = chamferRect(6.5, 6.5, 2.4);
    loftSections(
      warm,
      shaft,
      [
        { y: 0, sx: 1.25, sz: 1.25 },
        { y: 18, sx: 1, sz: 1 },
        { y: 128, sx: 0.72, sz: 0.72 },
      ],
      tm,
    );
    // crown: flared dark-glass observation ring between titanium bands
    const crown = chamferRect(10, 10, 4);
    taperedPrism(dark, crown, 128, 130, [0.55, 0.55], [1, 1], { matrix: tm, capBottom: true });
    taperedPrism(glass, crown, 130, 137, [1, 1], [1.06, 1.06], { matrix: tm });
    taperedPrism(glow, crown, 137, 137.5, [1.07, 1.07], [1.07, 1.07], { matrix: tm });
    taperedPrism(dark, crown, 137.5, 140, [1.07, 1.07], [0.8, 0.8], { matrix: tm, capTop: true });
    // mast
    taperedPrism(warm, chamferRect(1.2, 1.2, 0.4), 140, 176, [1, 1], [0.25, 0.25], { matrix: tm, capTop: true });
    taperedPrism(glow, chamferRect(0.5, 0.5, 0.15), 166, 168.5, [1, 1], [1, 1], { matrix: tm });

    // --- low annex blocks framing the hall ---
    taperedPrism(warm, chamferRect(22, 30, 3), 0, 16, [1, 1], [1, 1], { matrix: new Matrix4().makeTranslation(-62, 0, 52), capTop: true });
    taperedPrism(dark, chamferRect(22.4, 30.4, 3), 15.2, 16.4, [1, 1], [1, 1], { matrix: new Matrix4().makeTranslation(-62, 0, 52), capTop: true });
    taperedPrism(warm, chamferRect(18, 26, 3), 0, 22, [1, 1], [1, 1], { matrix: new Matrix4().makeTranslation(98, 0, -30), capTop: true });

    for (const [b, mat, cast] of [
      [warm, getCladdingMaterial('warm'), true],
      [dark, lib.graphite, true],
      [glass, lib.darkGlass, false],
      [glow, lib.glow.cyan, false],
    ] as const) {
      const m = meshOf(b, mat, owned, { cast, receive: cast });
      if (m) root.add(m);
    }
    return { root, owned };
  }, []);
  return (
    <group name="l1-facility" position={[px, py, pz]}>
      <FacilityBase size={[300, 220]} depth={96} steps={3} bottomScale={0.3} />
      <primitive object={built.root} />
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Far needles                                                         */
/* ------------------------------------------------------------------ */

export function Needles({ items }: { items: { x: number; z: number; top: number; radius: number }[] }) {
  const beacons: Beacon[] = items.map((n) => ({ base: [n.x, -230, n.z], top: n.top, radius: n.radius }));
  return <Beacons beacons={beacons} />;
}

/* ------------------------------------------------------------------ */
/* Runway piers & start plaza                                          */
/* ------------------------------------------------------------------ */

/** Sculpted chalice piers under the (flat) runway, plunging into the cloud sea. */
export function RunwayPiers({ piers, deckY = 0, thickness = 1.2 }: { piers: { z: number; deckWidth: number }[]; deckY?: number; thickness?: number }) {
  return (
    <group name="l1-runway-piers">
      {piers.map((p) => (
        <Pylon key={p.z} position={[0, deckY - thickness, p.z]} height={190} deckWidth={p.deckWidth} />
      ))}
    </group>
  );
}

/** Underside of the start plaza (the collidable top is a LevelDef box piece). */
export function StartPlaza() {
  return (
    <group name="l1-start-plaza">
      <FacilityBase position={[0, -3.2, 30]} size={[64, 60]} depth={34} steps={2} bottomScale={0.35} />
    </group>
  );
}
