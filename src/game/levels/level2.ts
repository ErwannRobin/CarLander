/**
 * LEVEL 2 — CLEAR THE GAP (theme 'canyon').
 *
 * Teaches: flips/rotations on two practice kickers (optional, scored), realigning with SHIFT, a
 * short thrust (boost up the big ramp, or in the air) to clear a 190 m chasm through a suspended
 * ring gate, and a four-wheel landing on a long ski-jump hill. Geometry: ./level2/geometry.ts; derived feature
 * positions: ./level2/course.ts; reference autopilot: ./level2/pilot.ts.
 *
 * Fuel is deliberately a small tank (0.5 s): holding SPACE up the ramp or after the lip simply
 * empties it, so the jump stays forgiving for any reasonable thrust start / duration while still
 * requiring thrust (a W-only launch crashes on the catch shelf under the knuckle).
 */
import type { Autopilot } from '../sim/autopilot';
import type { LevelDef } from '../types';
import { buildLevel2 } from './level2/level';
import { createLevel2Pilot } from './level2/pilot';

export { L2_RING_BONUS } from './level2/level';

export const LEVEL_2: LevelDef = buildLevel2();

/** Reference solution (headless completion tests and `?autopilot=1` demo runs). Fresh pilot each call. */
export function level2Pilot(): Autopilot {
  return createLevel2Pilot();
}
