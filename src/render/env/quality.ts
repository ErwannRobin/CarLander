import { QUALITY_PRESETS, type QualityPreset } from '@/config/quality';
import { runtime } from '@/game/runtime';
import type { QualityLevel } from '@/game/types';

/** Accepts a preset, a level name, or nothing (falls back to `runtime.quality`). */
export function resolveQuality(q?: QualityPreset | QualityLevel | null): QualityPreset {
  if (!q) return runtime.quality;
  return typeof q === 'string' ? QUALITY_PRESETS[q] : q;
}
