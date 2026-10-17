import { useThree } from '@react-three/fiber';
import { EffectComposer, N8AO } from '@react-three/postprocessing';
import { BlendFunction, BloomEffect, SMAAEffect, SMAAPreset, VignetteEffect, VignetteTechnique } from 'postprocessing';
import { useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
import { HalfFloatType } from 'three';
import type { QualityPreset } from '@/config/quality';
import type { QualityLevel, ThemeId } from '@/game/types';
import { resolveQuality } from '@/render/env/quality';
import { resolveTheme, type ThemeDef } from '@/render/env/themes';
import { FilmGrade, HeatDistortion, SpeedFX } from './components';

export interface PostFXProps {
  /** Theme id or definition (exposure, bloom, AO, vignette, grade). */
  theme: ThemeId | ThemeDef;
  /** Quality preset or level; defaults to `runtime.quality`. */
  quality?: QualityPreset | QualityLevel;
  /** Disable the whole stack (R3F then renders normally — note: no tone mapping). */
  enabled?: boolean;
  /** Override quality.screenFx for the heat shimmer / speed treatment. */
  screenFx?: boolean;
}

/** Above this drawing-buffer size N8AO runs at half resolution (depth-aware upsampling). */
const AO_FULL_RES_MAX_PIXELS = 2.6e6;
/** Above this drawing-buffer size MSAA is capped at 2x (retina density hides the difference). */
const MSAA_4X_MAX_PIXELS = 4.5e6;

/** The parts of n8ao's N8AOPostPass touched here (not exported in its typings). */
interface N8AOPassLike {
  configuration: { transparencyAware: boolean };
  /** When true, the pass re-traverses the scene every frame looking for transparent materials. */
  autoDetectTransparency: boolean;
}

/**
 * Post-processing stack (EffectComposer, HalfFloat HDR buffers):
 *   N8AO (quality.ao) → heat shimmer (UV warp) + bloom (mipmap, emissives / exhaust only) →
 *   speed treatment (radial blur, streaks, edge dispersion) + vignette + exposure / AgX / grade →
 *   SMAA when the composer has no MSAA (quality.msaaSamples === 0).
 *
 * The renderer must run with tone mapping off (the canvas' `flat`): FilmGrade tone maps.
 *
 * ```tsx
 * <PostFX theme={level.theme} quality={quality} />
 * ```
 */
export function PostFX({ theme, quality, enabled = true, screenFx }: PostFXProps) {
  const def = resolveTheme(theme);
  const q = resolveQuality(quality);
  const fx = screenFx ?? q.screenFx;
  // Large drawing buffers (retina): AO goes half-res and MSAA caps at 2x. Measured on an M-series
  // GPU at 3200x1800, AO costs ~6 ms and MSAA 4x ~4 ms. These selectors only re-render on resize.
  const aoHalfRes = useThree((s) => s.size.width * s.size.height * s.viewport.dpr * s.viewport.dpr > AO_FULL_RES_MAX_PIXELS);
  const bigBuffer = useThree((s) => s.size.width * s.size.height * s.viewport.dpr * s.viewport.dpr > MSAA_4X_MAX_PIXELS);
  const msaa = bigBuffer ? Math.min(q.msaaSamples, 2) : q.msaaSamples;
  const useSmaa = msaa === 0;

  const bloom = useMemo(
    () =>
      new BloomEffect({
        // ADD (not the default SCREEN): screen blending is wrong for HDR values above 1
        blendFunction: BlendFunction.ADD,
        mipmapBlur: true,
        luminanceThreshold: 1,
        luminanceSmoothing: 0.2,
        intensity: 0.6,
        radius: 0.75,
      }),
    [],
  );
  const vignette = useMemo(() => new VignetteEffect({ technique: VignetteTechnique.DEFAULT, offset: 0.3, darkness: 0.45 }), []);
  // SMAA owns full-resolution edge / weight targets and lookup textures: only create it when used.
  const smaa = useMemo(() => (useSmaa ? new SMAAEffect({ preset: SMAAPreset.HIGH }) : null), [useSmaa]);
  useEffect(
    () => () => {
      bloom.dispose();
      vignette.dispose();
    },
    [bloom, vignette],
  );
  useEffect(() => () => smaa?.dispose(), [smaa]);

  // Layout effect: the very first composed frame already uses the theme's values.
  useLayoutEffect(() => {
    bloom.intensity = def.bloom.intensity;
    bloom.luminanceMaterial.threshold = def.bloom.threshold;
    bloom.luminanceMaterial.smoothing = def.bloom.smoothing;
    bloom.mipmapBlurPass.radius = def.bloom.radius;
    vignette.offset = def.vignette.offset;
    vignette.darkness = def.vignette.darkness;
  }, [def, bloom, vignette]);

  // N8AO auto-detects transparent objects and then re-renders the whole scene twice per frame
  // (transparent-only passes — which also re-render the shadow map and the ray-marched cloud sea).
  // While auto-detection is on it also traverses the scene every frame, and writing
  // `transparencyAware` only switches the detection off when the value actually changes — so turn
  // the detection off explicitly. Our transparents are far clouds / additive VFX: plain AO is
  // visually equivalent and several ms cheaper.
  const aoRef = useCallback((pass: N8AOPassLike | null) => {
    if (!pass) return;
    pass.autoDetectTransparency = false;
    pass.configuration.transparencyAware = false;
  }, []);

  return (
    <EffectComposer
      // Adding / removing N8AO changes whether the composer's (multisampled) input buffer carries a
      // depth texture; detaching it from a live MSAA target makes every later resolve blit fail
      // (GL_INVALID_OPERATION). AO toggles are rare (quality changes): rebuild the composer instead.
      key={q.ao ? 'ao' : 'no-ao'}
      enabled={enabled}
      multisampling={msaa}
      frameBufferType={HalfFloatType}
      stencilBuffer={false}
    >
      {q.ao && (
        <N8AO
          ref={aoRef}
          aoRadius={def.ao.radius}
          intensity={def.ao.intensity}
          distanceFalloff={1}
          quality={q.level === 'high' ? 'medium' : 'low'}
          halfRes={q.level !== 'high' || aoHalfRes}
          color="black"
        />
      )}
      {fx && <HeatDistortion />}
      {q.bloom && <primitive object={bloom} />}
      {fx && <SpeedFX samples={q.level === 'high' ? 10 : 7} />}
      <primitive object={vignette} />
      <FilmGrade theme={def} />
      {smaa && <primitive object={smaa} />}
    </EffectComposer>
  );
}
