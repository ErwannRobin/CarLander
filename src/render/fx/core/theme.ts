/**
 * Per-theme art direction of the FX module (kept local: the FX module does not depend on the env
 * module, only on the theme id).
 *
 *  - `emissive`: multiplier on every emissive (HDR) FX contribution — exhaust, RCS jets, glow
 *    particles, energy rings, markers. Themes run different exposures / bloom thresholds in the
 *    post stack (night: exposure 1.2, threshold 0.85 vs morning 0.82 / 1.3), so the same HDR value
 *    blooms into a featureless blob at night. This keeps emissive FX consistently shaped.
 *  - `smokeFallback`: smoke shading when the scene has no lights to sample.
 *  - `smokeFloor`: minimum smoke shading when sampling scene lights — stands in for light the probe
 *    cannot see (local flood / point lights at night).
 *  - `smokeSky`: diffuse sky light added to the sampled lights — the env module lights PBR materials
 *    mostly through the environment map (IBL), which the probe cannot sample; without it the shadow
 *    side of white smoke would turn beige-grey instead of a cool, airy light grey.
 */
import { runtime } from '@/game/runtime';
import type { ThemeId } from '@/game/types';
import type { RGB } from './math';

export interface FXThemeLook {
  emissive: number;
  smokeFallback: { lit: RGB; dark: RGB };
  smokeFloor: { lit: RGB; dark: RGB };
  smokeSky: RGB;
}

export const FX_THEMES: Readonly<Record<ThemeId, FXThemeLook>> = {
  title: {
    emissive: 0.95,
    smokeFallback: { lit: [1.08, 1.06, 1.03], dark: [0.66, 0.69, 0.75] },
    smokeFloor: { lit: [0.62, 0.62, 0.64], dark: [0.36, 0.38, 0.42] },
    smokeSky: [0.46, 0.5, 0.58],
  },
  morning: {
    emissive: 1,
    smokeFallback: { lit: [1.1, 1.07, 1.01], dark: [0.68, 0.71, 0.77] },
    smokeFloor: { lit: [0.62, 0.62, 0.64], dark: [0.36, 0.38, 0.42] },
    smokeSky: [0.5, 0.56, 0.66],
  },
  canyon: {
    emissive: 0.85,
    smokeFallback: { lit: [1.12, 1.0, 0.88], dark: [0.58, 0.57, 0.64] },
    smokeFloor: { lit: [0.6, 0.55, 0.5], dark: [0.3, 0.29, 0.32] },
    smokeSky: [0.36, 0.4, 0.5],
  },
  night: {
    emissive: 0.6,
    smokeFallback: { lit: [0.3, 0.32, 0.36], dark: [0.1, 0.11, 0.13] },
    smokeFloor: { lit: [0.3, 0.32, 0.36], dark: [0.11, 0.12, 0.14] },
    smokeSky: [0.04, 0.05, 0.08],
  },
};

/** Theme used by the FX: explicit override, else the running level's theme, else morning. */
export function resolveFXTheme(override?: ThemeId): ThemeId {
  return override ?? runtime.level?.theme ?? 'morning';
}
