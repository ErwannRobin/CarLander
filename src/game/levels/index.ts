import type { Autopilot } from '../sim/autopilot';
import type { LevelDef, LevelId } from '../types';
import { LEVEL_KICKFLIP, kickflipPilot } from './kickflip';
import { LEVEL_1, level1Pilot } from './level1';
import { LEVEL_3, level3Pilot } from './level3';
import { LEVEL_2 as LEVEL_CLEAR_THE_GAP, level2Pilot as clearTheGapPilot } from './level4';

/** Level registry. Each level module owns its LevelDef and a reference autopilot. */
const REGISTRY: Record<LevelId, { level: LevelDef; pilot: () => Autopilot }> = {
  1: { level: LEVEL_1, pilot: level1Pilot },
  2: { level: LEVEL_KICKFLIP, pilot: kickflipPilot },
  3: { level: LEVEL_3, pilot: level3Pilot },
  4: { level: LEVEL_CLEAR_THE_GAP, pilot: clearTheGapPilot },
};

export function getLevel(id: LevelId): LevelDef {
  return REGISTRY[id].level;
}

/** A fresh reference autopilot for the level (tests, `?autopilot=1` demo runs). */
export function createLevelPilot(id: LevelId): Autopilot {
  return REGISTRY[id].pilot();
}

export const LEVEL_IDS: LevelId[] = [1, 2, 3, 4];
