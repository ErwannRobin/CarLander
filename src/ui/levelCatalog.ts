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
      'A wide runway, a gentle kicker and an open gap above the clouds. Fire the thrusters after the lip, line up with the slope and settle into the rings.',
    skill: 'Thrust, pitch and a stabilized landing',
    theme: 'morning',
    requirement: null,
  },
  2: {
    id: 2,
    name: 'Clear the Gap',
    subtitle: 'Golden-hour canyon',
    description:
      'Two trick kickers, a boost up the big ramp, then a 190-metre chasm. Thread the ring, realign and land on all four wheels.',
    skill: 'Flips, thrust control and slope matching',
    theme: 'canyon',
    requirement: 'Finish Learn to Fly to unlock',
  },
  3: {
    id: 3,
    name: 'The Inverted Ramp',
    subtitle: 'Night arena',
    description:
      'Hold the vacuum up an 86-metre crescent, drive the beam upside down, then release, flip upright and stick the landing.',
    skill: 'Vacuum, inverted driving and recovery',
    theme: 'night',
    requirement: 'Finish Clear the Gap to unlock',
  },
};

export function levelName(id: LevelId): string {
  return LEVEL_CATALOG[id]?.name ?? `Level ${id}`;
}
