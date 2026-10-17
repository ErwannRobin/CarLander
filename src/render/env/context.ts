import { createContext, useContext } from 'react';
import type { QualityPreset } from '@/config/quality';
import type { AtmosphereUniforms } from './atmosphere';
import type { ThemeDef } from './themes';

export interface EnvContextValue {
  /** Shared far-field uniforms (updated in place on theme change). */
  atmosphere: AtmosphereUniforms;
  theme: ThemeDef;
  quality: QualityPreset;
}

export const EnvContext = createContext<EnvContextValue | null>(null);

/** Access the environment state; only valid inside <World>. */
export function useEnv(): EnvContextValue {
  const v = useContext(EnvContext);
  if (!v) throw new Error('useEnv(): environment components must be rendered inside <World>.');
  return v;
}
