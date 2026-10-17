/**
 * LEVEL 2 — CLEAR THE GAP (placeholder: the physics test ramp until the handcrafted level lands).
 */
import { rampDemoPilot } from '../sim/demoPilots';
import type { Autopilot } from '../sim/autopilot';
import type { LevelDef } from '../types';
import { TEST_RAMP } from './testLevels';

export const LEVEL_2: LevelDef = { ...TEST_RAMP, id: 2, theme: 'canyon' };

/** Reference solution (headless completion tests and `?autopilot=1` demo runs). */
export function level2Pilot(): Autopilot {
  return rampDemoPilot({ backflips: 1 });
}
