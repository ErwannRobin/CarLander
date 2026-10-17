/**
 * Shared material library for track pieces and the architecture kit.
 *
 * Materials are created lazily on first use and cached for the app lifetime (they are shared by
 * every level and kit instance, so level changes only dispose geometry). Call
 * `disposeLevelMaterials()` on full renderer teardown.
 *
 * UV channel convention (all geometry built by this module):
 *   uv  (channel 0) — layout: ribbon tops u = 0..1 across / v = meters; everything else metric.
 *   uv1 (channel 1) — metric meters everywhere; used by tiling detail maps.
 *
 * Detail maps pack an albedo multiplier in R; `withAlbedoDetail` injects it into the standard
 * shader (three's roughnessMap only reads G, so R is free) — a cheap "detail texture" that keeps
 * close-up surfaces rich without a second color texture.
 */
import {
  AdditiveBlending,
  Color,
  DoubleSide,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type Texture,
} from 'three';
import type { EdgeLight, TrackStyle } from '@/game/types';
import { PALETTE } from '@/render/palette';
import {
  disposeTrackTextures,
  getAsphaltDetail,
  getBrushedDetail,
  getConcreteDetail,
  getFasciaTextures,
  getFieldLayoutTextures,
  getLayoutTextures,
  getLedDotTexture,
  hasFieldLayout,
  type DetailTextures,
} from './textures/trackTextures';

export type LedColor = Exclude<EdgeLight, 'none'>;

/** Emissive LED tints and HDR multipliers (values > 1 feed the bloom pass). */
export const LED_TINTS: Record<LedColor, { hex: string; intensity: number }> = {
  // HDR multipliers chosen against the theme bloom masks (smoothstep(threshold, threshold +
  // smoothing, luminance): night 0.85+0.3 / canyon 1.1+0.25 / morning 1.3+0.25, see
  // render/env/themes). Red is the Level-3 hero: ×5.2 ≈ 1.21 lum fully engages the night bloom,
  // so the halo is saturated red while the overexposed core reads pale salmon under AgX — exactly
  // how the reference footage records red LED strips. Daylight tints only need a hint of bloom:
  // orange ×3.4 ≈ 1.2 lum, cyan ×2.2 ≈ 1.45, white ×2.4 ≈ 2.1.
  cyan: { hex: PALETTE.cyan, intensity: 2.2 },
  red: { hex: PALETTE.red, intensity: 5.2 },
  orange: { hex: PALETTE.orange, intensity: 3.4 },
  white: { hex: '#fff1de', intensity: 2.4 },
};

/**
 * Additive spill strength per tint at full (night) strength — the level build scales it down for
 * daylight themes (LevelBuildOptions.ledSpill). Restrained: a glow on the concrete, not a light.
 */
const SPILL_STRENGTH: Record<LedColor, number> = { red: 0.55, orange: 0.35, cyan: 0.22, white: 0.18 };

/**
 * Detail-map shader chunk (after map_fragment): the R channel modulates albedo. Two octaves —
 * the authored tile and a rotated sample ~7x larger — break up the tile grid that otherwise
 * becomes visible at mid range; with distance the fine octave fades out (it would only alias and
 * reveal the repetition). `rfDetailUv` / `rfDetailFade` are reused by the roughness chunk below.
 */
const DETAIL_ALBEDO_CHUNK = /* glsl */ `
#include <map_fragment>
#ifdef USE_ROUGHNESSMAP
  vec2 rfDetailUv = mat2( 0.8, 0.6, -0.6, 0.8 ) * vRoughnessMapUv * 0.137 + vec2( 0.31, 0.67 );
  float rfDetailFade = 1.0 - smoothstep( 20.0, 110.0, length( vViewPosition ) );
  {
    float rfNear = texture2D( roughnessMap, vRoughnessMapUv ).r;
    float rfFar = texture2D( roughnessMap, rfDetailUv ).r;
    float rfDetail = mix( rfFar, rfNear * 0.65 + rfFar * 0.35, rfDetailFade );
    diffuseColor.rgb *= mix( 1.0, rfDetail * 2.0, uDetailStrength * mix( 0.6, 1.0, rfDetailFade ) );
  }
#endif
`;

/** Roughness (G channel) with the same two-octave / distance treatment as the albedo detail. */
const DETAIL_ROUGHNESS_CHUNK = /* glsl */ `
float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
  vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );
  float rfRoughFar = texture2D( roughnessMap, rfDetailUv ).g;
  roughnessFactor *= mix( rfRoughFar, texelRoughness.g * 0.7 + rfRoughFar * 0.3, rfDetailFade );
#endif
`;

/**
 * Turns the material's roughnessMap into a combined detail map: R = albedo multiplier (0.5 =
 * neutral, scaled by `strength`), G = roughness — both anti-tiled (see DETAIL_ALBEDO_CHUNK).
 */
export function withAlbedoDetail<T extends MeshStandardMaterial>(mat: T, strength: number): T {
  const uDetailStrength = { value: strength };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDetailStrength = uDetailStrength;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uDetailStrength;')
      .replace('#include <map_fragment>', DETAIL_ALBEDO_CHUNK)
      .replace('#include <roughnessmap_fragment>', DETAIL_ROUGHNESS_CHUNK);
  };
  mat.customProgramCacheKey = () => 'rf-albedo-detail-2';
  mat.userData.detailStrength = uDetailStrength;
  return mat;
}

/** Clone of a texture sharing its image source (single GPU upload) with a different tile size. */
export function retile(tex: Texture, tileU: number, tileV = tileU): Texture {
  const t = tex.clone();
  t.repeat.set(1 / tileU, 1 / tileV);
  return t;
}

function detailed(
  params: ConstructorParameters<typeof MeshStandardMaterial>[0],
  detail: DetailTextures,
  normalScale: number,
  albedo: number,
): MeshStandardMaterial {
  const m = new MeshStandardMaterial({
    ...params,
    roughnessMap: detail.detail,
    normalMap: detail.normal,
  });
  m.normalScale.set(normalScale, normalScale);
  return withAlbedoDetail(m, albedo);
}

function emissiveBasic(hex: string, intensity: number, map: Texture | null = null): MeshBasicMaterial {
  return new MeshBasicMaterial({
    color: new Color(hex).multiplyScalar(intensity),
    map,
    toneMapped: false,
    fog: true,
  });
}

/**
 * Drive-surface material of a style. `field` = the marking-free variant used on wide box tops
 * (see getFieldLayoutTextures); styles without linear markings ignore it.
 */
function makeTopMaterial(style: TrackStyle, field = false): MeshStandardMaterial {
  const layout = (field ? getFieldLayoutTextures(style) : null) ?? getLayoutTextures(style);
  const base = { color: '#ffffff', map: layout.map, metalness: 0 } as const;
  switch (style) {
    case 'runway': {
      const m = detailed({ ...base, roughness: 1 }, getAsphaltDetail(), 0.6, 0.75);
      if (layout.emissive) {
        m.emissiveMap = layout.emissive;
        m.emissive.set(PALETTE.cyan);
        m.emissiveIntensity = 0.38;
      }
      return m;
    }
    case 'ramp':
      return detailed({ ...base, roughness: 1 }, getAsphaltDetail(), 0.6, 0.75);
    case 'landing':
      return detailed({ ...base, roughness: 1 }, getConcreteDetail(), 0.4, 0.6);
    case 'platform':
      return detailed({ ...base, roughness: 1 }, getConcreteDetail(), 0.4, 0.6);
    case 'adhesive': {
      // polished: the detail roughness (~0.78) is scaled down by material.roughness
      const m = detailed({ ...base, roughness: 0.6, envMapIntensity: 1.1 }, getConcreteDetail(), 0.22, 0.5);
      if (layout.emissive) {
        m.emissiveMap = layout.emissive;
        m.emissive.set(PALETTE.cyan);
        // calibrated for the night arena (L3, where this surface lives): self-lit, so it must stay
        // a faint hint on the unlit inverted beam instead of turning into a neon grid
        m.emissiveIntensity = 0.32;
      }
      return m;
    }
    case 'metal':
      return detailed({ ...base, metalness: 1, roughness: 0.75 }, getBrushedDetail(), 0.25, 0.5);
    case 'glass':
      return new MeshStandardMaterial({ ...base, metalness: 0.5, roughness: 0.07, envMapIntensity: 1.4 });
  }
}

export interface LevelMaterials {
  /** Drive-surface material per track style. */
  top: Record<TrackStyle, MeshStandardMaterial>;
  /** Slab sides / underside: architectural concrete fascia. */
  sideConcrete: MeshStandardMaterial;
  /** Slab sides for metal / glass decks: brushed titanium. */
  sideMetal: MeshStandardMaterial;
  /** Collidable side rails. */
  rail: MeshStandardMaterial;
  /** Thin edge caps along every deck edge. */
  trim: MeshStandardMaterial;
  /** Emissive LED strips (bloom-friendly, dotted diffuser). */
  led: Record<LedColor, MeshBasicMaterial>;
  /** Plain emissive bars without the LED dot pattern (light bars, seams). */
  glow: Record<LedColor, MeshBasicMaterial>;
  /** Additive light spill next to LED strips (vertex-color falloff). */
  spill: Record<LedColor, MeshBasicMaterial>;
  /** Floodlight lens / lamp (warm white, very bright). */
  lamp: MeshBasicMaterial;
  /** Warm white architectural concrete (pylons, piers). */
  pylon: MeshStandardMaterial;
  /** Truss / lattice steel. */
  steel: MeshStandardMaterial;
  /** Brushed titanium panels (kit). */
  titanium: MeshStandardMaterial;
  /** Satin graphite metal (housings, frames). */
  graphite: MeshStandardMaterial;
  /** Matte dark graphite (recesses, undersides). */
  graphiteMatte: MeshStandardMaterial;
  /** Warm white clear-coated panels (monoliths, arches). */
  warmWhite: MeshPhysicalMaterial;
  /** Dark reflective glass (signage, facades). */
  darkGlass: MeshStandardMaterial;
  /** Sandstone rock (vertex colored strata). */
  rock: MeshStandardMaterial;
}

let library: LevelMaterials | null = null;

/**
 * Other lazily-created caches of this module (kit cladding, target artwork, glow sprite) register
 * their release function here so `disposeLevelMaterials()` is a complete teardown. Registration
 * happens at module load of the cache owner, so materials.ts never imports them (no cycles).
 */
const teardownHooks = new Set<() => void>();

/** Registers a cache release function run by `disposeLevelMaterials()`. */
export function onLevelMaterialsDispose(release: () => void): void {
  teardownHooks.add(release);
}

/** The shared material library (created on first call). */
export function getLevelMaterials(): LevelMaterials {
  if (library) return library;
  const concrete = getConcreteDetail();
  const brushed = getBrushedDetail();
  const fascia = getFasciaTextures();

  const sideConcrete = detailed({ color: '#ffffff', map: fascia.map, roughness: 1 }, concrete, 0.35, 0.5);
  const sideMetal = detailed({ color: PALETTE.titanium300, metalness: 1, roughness: 0.8 }, brushed, 0.25, 0.5);
  const rail = detailed({ color: PALETTE.titanium200, metalness: 1, roughness: 0.7 }, brushed, 0.25, 0.4);

  const led = {} as Record<LedColor, MeshBasicMaterial>;
  const glow = {} as Record<LedColor, MeshBasicMaterial>;
  const spill = {} as Record<LedColor, MeshBasicMaterial>;
  for (const key of Object.keys(LED_TINTS) as LedColor[]) {
    const t = LED_TINTS[key];
    led[key] = emissiveBasic(t.hex, t.intensity, getLedDotTexture());
    glow[key] = emissiveBasic(t.hex, t.intensity * 0.9);
    spill[key] = new MeshBasicMaterial({
      color: new Color(t.hex).multiplyScalar(SPILL_STRENGTH[key]),
      vertexColors: true,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
  }

  const rockNormal = retile(concrete.normal, 7);
  const rock = new MeshStandardMaterial({
    color: '#ffffff',
    vertexColors: true,
    roughness: 0.93,
    metalness: 0,
    normalMap: rockNormal,
  });
  rock.normalScale.set(0.9, 0.9);

  const top = {} as Record<TrackStyle, MeshStandardMaterial>;
  for (const s of ['runway', 'ramp', 'landing', 'adhesive', 'platform', 'metal', 'glass'] as TrackStyle[]) {
    top[s] = makeTopMaterial(s);
  }

  library = {
    top,
    spill,
    sideConcrete,
    sideMetal,
    rail,
    trim: new MeshStandardMaterial({ color: PALETTE.titanium200, metalness: 1, roughness: 0.3 }),
    led,
    glow,
    lamp: emissiveBasic('#fff4e2', 7),
    pylon: detailed({ color: '#c9c3b8', roughness: 1 }, concrete, 0.3, 0.45),
    // galvanized / aluminium truss: mostly diffuse so lattices read light against any sky
    steel: new MeshStandardMaterial({ color: '#cdd2d8', metalness: 0.3, roughness: 0.5 }),
    titanium: detailed({ color: PALETTE.titanium300, metalness: 1, roughness: 0.62 }, brushed, 0.2, 0.4),
    graphite: new MeshStandardMaterial({ color: PALETTE.graphite600, metalness: 0.25, roughness: 0.46 }),
    graphiteMatte: new MeshStandardMaterial({ color: PALETTE.graphite800, metalness: 0.1, roughness: 0.8 }),
    warmWhite: new MeshPhysicalMaterial({
      color: PALETTE.warmWhite,
      roughness: 0.5,
      metalness: 0,
      clearcoat: 0.55,
      clearcoatRoughness: 0.28,
    }),
    darkGlass: new MeshStandardMaterial({
      color: PALETTE.glass,
      metalness: 0.65,
      roughness: 0.06,
      envMapIntensity: 1.5,
      side: DoubleSide,
    }),
    rock,
  };
  return library;
}

const fieldTops = new Map<TrackStyle, MeshStandardMaterial>();

/**
 * Drive-surface material for WIDE box tops: the style's marking-free field variant (created on
 * first use, cached with the library), or the regular `top[style]` for styles without linear
 * markings.
 */
export function getFieldTopMaterial(style: TrackStyle): MeshStandardMaterial {
  if (!hasFieldLayout(style)) return getLevelMaterials().top[style];
  let m = fieldTops.get(style);
  if (!m) {
    m = makeTopMaterial(style, true);
    fieldTops.set(style, m);
  }
  return m;
}

/**
 * Disposes the shared materials and every cached procedural texture of the module — track
 * textures, kit cladding, target artwork, glow sprite (full renderer teardown only). Everything is
 * re-created lazily on next use.
 */
export function disposeLevelMaterials(): void {
  for (const release of teardownHooks) release();
  for (const m of fieldTops.values()) m.dispose();
  fieldTops.clear();
  if (!library) {
    disposeTrackTextures();
    return;
  }
  const lib = library;
  const mats: { dispose(): void }[] = [
    ...Object.values(lib.top),
    ...Object.values(lib.led),
    ...Object.values(lib.glow),
    ...Object.values(lib.spill),
    lib.sideConcrete,
    lib.sideMetal,
    lib.rail,
    lib.trim,
    lib.lamp,
    lib.pylon,
    lib.steel,
    lib.titanium,
    lib.graphite,
    lib.graphiteMatte,
    lib.warmWhite,
    lib.darkGlass,
    lib.rock,
  ];
  for (const m of mats) m.dispose();
  lib.rock.normalMap?.dispose(); // retiled clone (shares the cached image source)
  library = null;
  disposeTrackTextures();
}
