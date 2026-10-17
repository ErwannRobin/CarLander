/**
 * The grand gateway at the runway start: two monumental warm-white towers plunging into the cloud
 * sea, a slender graphite bridge carrying the level name with a cyan light line, and cable-stay
 * fans from the tower heads to the runway edges (the runway reads as a cable-stayed deck).
 */
import { DoubleSide, Group, Matrix4, Mesh, MeshStandardMaterial, PlaneGeometry } from 'three';
import { useEffect } from 'react';
import type { V3 } from '@/game/types';
import { CableStays, getCladdingMaterial, getLevelMaterials } from '@/render/level';
import { chamferRect, GeoBuilder, loftSections, taperedPrism } from '@/render/level/geometry/GeoBuilder';
import { drawLabel, ensureFonts } from '@/render/level/textures/textTextures';
import { PALETTE } from '@/render/palette';
import { meshOf, useBuilt, type Disposable } from './useBuilt';

export interface GatewayProps {
  /** World z of the gateway plane. */
  z: number;
  /** Runway half width at the gateway (m). */
  halfWidth: number;
  /** Runway surface height (m). */
  deckY?: number;
  text?: string;
}

const TOWER_X = 23;
const TOP = 54;
const BOTTOM = -185;
const BEAM_Y = 40;

export function Gateway({ z, halfWidth, deckY = 0, text = 'LEARN TO FLY' }: GatewayProps) {
  const built = useBuilt(() => {
    const lib = getLevelMaterials();
    const owned: Disposable[] = [];
    const root = new Group();
    root.name = 'l1-gateway';
    const towers = new GeoBuilder();
    const dark = new GeoBuilder();
    const glow = new GeoBuilder();
    const prof = chamferRect(4.6, 3.6, 1.1);
    for (const s of [-1, 1]) {
      const m = new Matrix4().makeTranslation(s * TOWER_X, 0, z);
      // tower: slight entasis, flaring toward the clouds, slimming to the crown
      loftSections(
        towers,
        prof,
        [
          { y: BOTTOM, sx: 1.45, sz: 1.45 },
          { y: -60, sx: 1.12, sz: 1.12 },
          { y: deckY, sx: 1, sz: 1 },
          { y: TOP - 6, sx: 0.78, sz: 0.78 },
        ],
        m,
      );
      // crown: recessed graphite shadow gap + proud warm cap
      taperedPrism(dark, chamferRect(4.6 * 0.74, 3.6 * 0.74, 0.8), TOP - 6, TOP - 5.2, [1, 1], [1, 1], { matrix: m });
      taperedPrism(towers, chamferRect(4.6 * 0.8, 3.6 * 0.8, 0.9), TOP - 5.2, TOP, [1, 1], [0.94, 0.94], { matrix: m, capTop: true });
      // inner-face cyan seam (faces the runway)
      const seamX = s * (TOWER_X - 4.6 * 0.9) - s * 0.05;
      const seam = new Matrix4().makeTranslation(seamX, 0, z);
      taperedPrism(glow, chamferRect(0.06, 0.32, 0), deckY + 2, TOP - 9, [1, 1], [1, 1], { matrix: seam, capTop: true, capBottom: true });
      // base plinth ring at runway level (where the deck fascia meets the tower)
      taperedPrism(dark, chamferRect(4.6 * 1.04, 3.6 * 1.04, 1.2), deckY - 2.2, deckY + 0.4, [1, 1], [1, 1], { matrix: m, capTop: true });
    }
    // bridge between the towers
    const beamLen = TOWER_X * 2 - 4.6 * 1.4;
    taperedPrism(dark, chamferRect(beamLen / 2, 2.2, 0.4), BEAM_Y, BEAM_Y + 4.8, [1, 1], [1, 1], {
      matrix: new Matrix4().makeTranslation(0, 0, z),
      capTop: true,
      capBottom: true,
    });
    // cyan light line under the bridge
    taperedPrism(glow, chamferRect(beamLen / 2 - 0.6, 0.18, 0), BEAM_Y - 0.12, BEAM_Y + 0.02, [1, 1], [1, 1], {
      matrix: new Matrix4().makeTranslation(0, 0, z + 1.4),
      capTop: true,
      capBottom: true,
    });
    const tm = meshOf(towers, getCladdingMaterial('warm'), owned);
    const dm = meshOf(dark, lib.graphite, owned);
    const gm = meshOf(glow, lib.glow.cyan, owned, { cast: false, receive: false });
    for (const m of [tm, dm, gm]) if (m) root.add(m);
    // lettering panel on the bridge front (faces +Z, the approaching car)
    const panelGeo = new PlaneGeometry(1, 1);
    const panelMat = new MeshStandardMaterial({ color: PALETTE.graphite800, roughness: 0.35, metalness: 0.4, side: DoubleSide });
    owned.push(panelGeo, panelMat);
    const panel = new Mesh(panelGeo, panelMat);
    panel.position.set(0, BEAM_Y + 2.4, z + 2.21);
    panel.scale.set(beamLen * 0.62, 3.2, 1);
    root.add(panel);
    return { root, owned, panel, panelMat, beamLen };
  }, [z, deckY]);

  // lettering texture (fonts) applied after mount; StrictMode-safe
  useEffect(() => {
    let alive = true;
    let tex: ReturnType<typeof drawLabel> | null = null;
    void ensureFonts().then(() => {
      if (!alive) return;
      tex = drawLabel({ text, fontPx: 150, trackingEm: 0.55, padEm: 1.1, background: PALETTE.graphite800, rule: null });
      const m = built.panelMat;
      m.map = tex.texture;
      m.emissiveMap = tex.texture;
      m.emissive.set('#ffffff');
      m.emissiveIntensity = 0.55;
      m.color.set('#ffffff');
      m.needsUpdate = true;
      built.panel.scale.set(3.2 * tex.aspect, 3.2, 1);
    });
    return () => {
      alive = false;
      tex?.texture.dispose();
    };
  }, [built, text]);

  // cable-stay fans: from each tower head down to the runway edge, ahead of and behind the gateway
  const stayZ = [-78, -58, -40, -24, 24, 40, 56];
  const fans = [-1, 1].map((s) => {
    const anchor: V3 = [s * (TOWER_X - 3.8), BEAM_Y - 2, z];
    const points: V3[] = stayZ.map((dz) => [s * (halfWidth + 0.35), deckY - 0.7, z + dz]);
    return { s, anchor, points };
  });

  return (
    <group>
      <primitive object={built.root} />
      {fans.map((f) => (
        <CableStays key={f.s} anchor={f.anchor} points={f.points} radius={0.11} />
      ))}
    </group>
  );
}
