import type { LevelId } from '@/game/types';
import { KickflipDecor } from './KickflipDecor';
import { Level1Decor } from './Level1Decor';
import { Level2Decor } from './Level2Decor';
import { Level3Decor } from './Level3Decor';

/** Per-level monumental scenery (non-gameplay decor), composed from the architecture kit. */
export function LevelDecor({ levelId }: { levelId: LevelId }) {
  if (levelId === 1) return <Level1Decor />;
  if (levelId === 2) return <KickflipDecor />;
  if (levelId === 4) return <Level2Decor />;
  return <Level3Decor />;
}
