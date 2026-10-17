/**
 * Cached materials/textures specific to kit megastructures (panelled cladding).
 * Panel maps are metric (uv channel 0), 12 m x 16 m per tile.
 */
import { MeshPhysicalMaterial, MeshStandardMaterial, type CanvasTexture } from 'three';
import { onLevelMaterialsDispose, withAlbedoDetail } from '../materials';
import { createCanvas, makeTexture, mulberry32 } from '../textures/canvasUtils';
import { getBrushedDetail, getConcreteDetail } from '../textures/trackTextures';

export type CladdingVariant = 'warm' | 'graphite';

const panelMaps = new Map<CladdingVariant, CanvasTexture>();

/** Panel cladding: 3 m x 4 m panels with crisp joints and subtle per-panel tone. */
export function getPanelMap(variant: CladdingVariant): CanvasTexture {
  let t = panelMaps.get(variant);
  if (t) return t;
  const U = 12;
  const V = 16;
  const ppm = 64;
  const { canvas, ctx } = createCanvas(U * ppm, V * ppm);
  ctx.scale(ppm, ppm);
  const warm = variant === 'warm';
  ctx.fillStyle = warm ? '#ebe6dc' : '#363b42';
  ctx.fillRect(0, 0, U, V);
  const rng = mulberry32(warm ? 901 : 902);
  const pw = 3;
  const ph = 4;
  for (let y = 0; y < V; y += ph) {
    for (let x = 0; x < U; x += pw) {
      const k = (rng() - 0.5) * (warm ? 0.05 : 0.07);
      ctx.fillStyle = k > 0 ? `rgba(255,255,255,${k})` : `rgba(0,0,0,${-k})`;
      ctx.fillRect(x, y, pw, ph);
      // faint inner reveal on some panels
      if (rng() > 0.7) {
        ctx.fillStyle = warm ? 'rgba(120,112,100,0.18)' : 'rgba(0,0,0,0.25)';
        ctx.fillRect(x + 0.2, y + ph * 0.5, pw - 0.4, 0.02);
      }
    }
  }
  const joint = warm ? 'rgba(110,102,92,0.75)' : 'rgba(8,9,11,0.85)';
  const lip = warm ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.06)';
  for (let x = 0; x <= U; x += pw) {
    ctx.fillStyle = joint;
    ctx.fillRect(x - 0.015, 0, 0.03, V);
    ctx.fillStyle = lip;
    ctx.fillRect(x + 0.015, 0, 0.012, V);
  }
  for (let y = 0; y <= V; y += ph) {
    ctx.fillStyle = joint;
    ctx.fillRect(0, y - 0.015, U, 0.03);
    ctx.fillStyle = lip;
    ctx.fillRect(0, y + 0.015, U, 0.012);
  }
  t = makeTexture(canvas, { color: true, channel: 0 });
  t.repeat.set(1 / U, 1 / V);
  panelMaps.set(variant, t);
  return t;
}

const cladding = new Map<CladdingVariant, MeshStandardMaterial>();

/** Panelled megastructure cladding: warm white (satin clear-coat) or graphite (brushed metal). */
export function getCladdingMaterial(variant: CladdingVariant): MeshStandardMaterial {
  let m = cladding.get(variant);
  if (m) return m;
  if (variant === 'warm') {
    const d = getConcreteDetail();
    const mat = new MeshPhysicalMaterial({
      color: '#ffffff',
      map: getPanelMap('warm'),
      roughness: 0.62,
      roughnessMap: d.detail,
      normalMap: d.normal,
      clearcoat: 0.35,
      clearcoatRoughness: 0.3,
    });
    mat.normalScale.set(0.15, 0.15);
    m = withAlbedoDetail(mat, 0.25);
  } else {
    const d = getBrushedDetail();
    const mat = new MeshStandardMaterial({
      color: '#ffffff',
      map: getPanelMap('graphite'),
      metalness: 0.3,
      roughness: 0.7,
      roughnessMap: d.detail,
      normalMap: d.normal,
    });
    mat.normalScale.set(0.15, 0.15);
    m = withAlbedoDetail(mat, 0.3);
  }
  cladding.set(variant, m);
  return m;
}

export function disposeKitMaterials(): void {
  for (const m of cladding.values()) m.dispose();
  for (const t of panelMaps.values()) t.dispose();
  cladding.clear();
  panelMaps.clear();
}

// part of the module-wide teardown (disposeLevelMaterials)
onLevelMaterialsDispose(disposeKitMaterials);

