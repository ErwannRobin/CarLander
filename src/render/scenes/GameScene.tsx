import type { QualityPreset } from '@/config/quality';
import type { LevelDef } from '@/game/types';
import { CameraRig } from '@/render/camera/CameraRig';
import { Car } from '@/render/car';
import { World } from '@/render/env';
import { GameFX } from '@/render/fx';
import { LevelGeometry } from '@/render/level';
import { LevelDecor } from '@/render/levels';
import { PostFX } from '@/render/post';

/** Visual content of a level. Remounted when graphics quality changes (sim state lives in GameController). */
export function GameScene({
  level,
  quality,
  showTrajectory,
}: {
  level: LevelDef;
  quality: QualityPreset;
  showTrajectory: boolean;
}) {
  return (
    <>
      <World theme={level.theme} quality={quality} />
      <LevelGeometry level={level} />
      <LevelDecor levelId={level.id} />
      <Car />
      <GameFX showTrajectory={showTrajectory} />
      <CameraRig />
      <PostFX theme={level.theme} quality={quality} />
    </>
  );
}
