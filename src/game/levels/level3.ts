/**
 * LEVEL 3 — THE INVERTED RAMP (placeholder: the physics vacuum test level until the handcrafted level lands).
 */
import { vacuumDemoPilot } from '../sim/demoPilots';
import type { Autopilot } from '../sim/autopilot';
import type { LevelDef } from '../types';
import { TEST_VACUUM } from './testLevels';

export const LEVEL_3: LevelDef = { ...TEST_VACUUM, id: 3 };

/** Reference solution (headless completion tests and `?autopilot=1` demo runs). */
export function level3Pilot(): Autopilot {
  return vacuumDemoPilot();
}
