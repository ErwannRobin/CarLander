import type { QualityLevel } from '@/game/types';

export interface QualityPreset {
  level: QualityLevel;
  /** Max device pixel ratio. */
  dpr: number;
  shadows: boolean;
  shadowMapSize: number;
  /** Screen-space ambient occlusion (N8AO). */
  ao: boolean;
  bloom: boolean;
  /** Multiplier on particle budgets (1 = full). */
  particles: number;
  /** Number of cloud sprites / layers budget multiplier. */
  clouds: number;
  /** Environment cube map resolution for reflections. */
  envMapSize: number;
  /** Antialiasing: MSAA samples on the composer (0 = SMAA fallback). */
  msaaSamples: number;
  /** Heat distortion / speed post effects. */
  screenFx: boolean;
  /** Terrain / distant geometry detail multiplier. */
  detail: number;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualityPreset> = {
  low: {
    level: 'low',
    dpr: 1,
    shadows: false,
    shadowMapSize: 1024,
    ao: false,
    bloom: true,
    particles: 0.4,
    clouds: 0.4,
    envMapSize: 128,
    msaaSamples: 0,
    screenFx: false,
    detail: 0.5,
  },
  medium: {
    level: 'medium',
    dpr: 1.5,
    shadows: true,
    shadowMapSize: 2048,
    ao: false,
    bloom: true,
    particles: 0.7,
    clouds: 0.7,
    envMapSize: 256,
    msaaSamples: 4,
    screenFx: true,
    detail: 0.75,
  },
  high: {
    level: 'high',
    dpr: 2,
    shadows: true,
    shadowMapSize: 4096,
    ao: true,
    bloom: true,
    particles: 1,
    clouds: 1,
    envMapSize: 512,
    msaaSamples: 4,
    screenFx: true,
    detail: 1,
  },
};
