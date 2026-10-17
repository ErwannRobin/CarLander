/**
 * LEVEL 1 — LEARN TO FLY (placeholder: the physics test ramp until the handcrafted level lands).
 */
import { rampDemoPilot } from '../sim/demoPilots';
import type { Autopilot } from '../sim/autopilot';
import type { LevelDef } from '../types';
import { TEST_RAMP } from './testLevels';

export const LEVEL_1: LevelDef = { ...TEST_RAMP, id: 1 };

/** Reference solution (headless completion tests and `?autopilot=1` demo runs). */
export function level1Pilot(): Autopilot {
  return rampDemoPilot();
}
