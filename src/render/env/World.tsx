import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import type { QualityPreset } from '@/config/quality';
import type { LevelDef, QualityLevel, ThemeId } from '@/game/types';
import { applyThemeToAtmosphere, createAtmosphereUniforms } from './atmosphere';
import { Clouds } from './Clouds';
import { CloudSea } from './CloudSea';
import { EnvContext, type EnvContextValue } from './context';
import { EnvironmentMap } from './EnvironmentMap';
import { Landscape } from './Landscape';
import { resolveQuality } from './quality';
import { SceneAtmosphere } from './SceneAtmosphere';
import { Sky } from './Sky';
import { Sun } from './Sun';
import { releaseEnvTextures, retainEnvTextures } from './textures';
import { resolveTheme, type ThemeDef } from './themes';

export interface WorldProps {
  /**
   * Theme id ('title' | 'morning' | 'canyon' | 'night') or a custom ThemeDef. Custom definitions are
   * compared by content, so an inline object only triggers rebuilds when its values change.
   */
  theme: ThemeId | ThemeDef;
  /** Quality preset or level; defaults to `runtime.quality`. */
  quality?: QualityPreset | QualityLevel;
  /** Level whose structures the scattered cumulus avoid; defaults to (and tracks) `runtime.level`. */
  level?: LevelDef | null;
  /** Part toggles (all default true) — handy for debugging and profiling. */
  sky?: boolean;
  sun?: boolean;
  fog?: boolean;
  environment?: boolean;
  cloudSea?: boolean;
  clouds?: boolean;
  landscape?: boolean;
}

/**
 * The whole sky facility surroundings: sky dome, following sun + shadows, hemisphere fill, fog,
 * in-scene reflection environment, cloud sea, scattered cumulus and the distant landscape.
 *
 * ```tsx
 * <World theme={level.theme} quality={quality} />
 * ```
 */
export function World({
  theme,
  quality,
  level,
  sky = true,
  sun = true,
  fog = true,
  environment = true,
  cloudSea = true,
  clouds = true,
  landscape = true,
}: WorldProps) {
  // Keyed on content (deliberately not on `theme` identity): a custom ThemeDef re-created on every
  // parent render must not re-bake the reflection map / rebuild the landscape each time. Theme ids
  // are their own key.
  const themeKey = typeof theme === 'string' ? theme : JSON.stringify(theme);
  const def = useMemo(() => resolveTheme(theme), [themeKey]);
  const q = resolveQuality(quality);
  const atmosphere = useMemo(createAtmosphereUniforms, []);
  // Applied during render (idempotent) so children's effects — e.g. the env map bake — see it.
  useMemo(() => applyThemeToAtmosphere(atmosphere, def), [atmosphere, def]);

  // shared procedural textures: GPU copies are freed when the last <World> unmounts
  useEffect(() => {
    retainEnvTextures();
    return releaseEnvTextures;
  }, []);

  useFrame((state) => {
    atmosphere.uEnvTime.value = state.clock.elapsedTime % 3600;
  });

  const ctx = useMemo<EnvContextValue>(() => ({ atmosphere, theme: def, quality: q }), [atmosphere, def, q]);

  return (
    <EnvContext.Provider value={ctx}>
      <SceneAtmosphere fog={fog} />
      {sun && <Sun />}
      {sky && <Sky />}
      {environment && <EnvironmentMap />}
      {cloudSea && <CloudSea />}
      {landscape && def.landscape && <Landscape />}
      {clouds && <Clouds level={level} />}
    </EnvContext.Provider>
  );
}
