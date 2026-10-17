/**
 * Level presentation data for menus (names follow ARCHITECTURE §8). The sim's LevelDef carries
 * name / subtitle / description too; this catalog adds the menu-only copy (skill taught,
 * unlock requirement, theme) so the UI doesn't need to import level geometry.
 */
import type { LevelId, ThemeId } from '@/game/types';

export interface LevelCard {
  id: LevelId;
  name: string;
  subtitle: string;
  description: string;
  /** What the level teaches, in a few words. */
  skill: string;
  theme: Exclude<ThemeId, 'title'>;
  /** Shown on the card while locked. */
  requirement: string | null;
}

export const LEVEL_CATALOG: Record<LevelId, LevelCard> = {
  1: {
    id: 1,
    name: 'Learn to Fly',
    subtitle: 'Morning runway',
    description:
      'A wide runway, a gentle kicker and an open gap above the clouds. Fire the thrusters at the lip, then settle onto the target deck.',
    skill: 'Thrust and landing alignment',
    theme: 'morning',
    requirement: null,
  },
  2: {
    id: 2,
    name: 'Clear the Gap',
    subtitle: 'Golden-hour canyon',
    description:
      'Two kickers to practise flips, a boost straight, then a 160-metre chasm. Clear it and match the downslope to land.',
    skill: 'Tricks and slope matching',
    theme: 'canyon',
    requirement: 'Finish Learn to Fly to unlock',
  },
  3: {
    id: 3,
    name: 'The Inverted Ramp',
    subtitle: 'Night arena',
    description:
      'Hold the vacuum up a 70-metre crescent, drive the beam upside down, release, flip upright and land on a distant platform.',
    skill: 'Vacuum and inverted recovery',
    theme: 'night',
    requirement: 'Finish Clear the Gap to unlock',
  },
};

export function levelName(id: LevelId): string {
  return LEVEL_CATALOG[id]?.name ?? `Level ${id}`;
}
