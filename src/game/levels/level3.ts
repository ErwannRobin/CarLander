/**
 * LEVEL 3 — THE INVERTED RAMP (theme 'night').
 *
 * Start runway → kicker → void → landing ramp onto the night arena → HOLD ENTER up an 86 m crescent
 * (quarter pipe R44, wall, overhang R36) → 130 m inverted beam curving right → RELEASE zone →
 * flip upright (SHIFT or Q/E) → ski-jump landing hill → finish.
 * Geometry: ./level3/geometry.ts · LevelDef: ./level3/def.ts · reference pilot: ./level3/pilot.ts
 * Proof: tests/levels/level3.test.ts.
 */
import type { Autopilot } from '../sim/autopilot';
import type { LevelDef } from '../types';
import { createLevel3 } from './level3/def';
import { L3_GEO } from './level3/geometry';
import { createL3Pilot } from './level3/pilot';

export const LEVEL_3: LevelDef = createLevel3(L3_GEO);

/** Reference solution (headless completion tests and `?autopilot=1` demo runs): a fresh pilot each call. */
export function level3Pilot(): Autopilot {
  return createL3Pilot(L3_GEO);
}
