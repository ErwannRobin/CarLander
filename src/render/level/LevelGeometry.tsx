/**
 * <LevelGeometry level={LevelDef} /> — renders every piece of a level:
 *  - ribbons (top per TrackStyle, concrete/metal slab sides, rails, edge caps, emissive edge LEDs)
 *  - box pieces
 *  - auto supports (pylons into the cloud sea, truss backing + tower behind steep sections)
 *  - zone markers (target rings, finish arch, gates, visible trigger zones e.g. RELEASE)
 *  - floating hint signage bound to objectives
 * Static geometry is merged per material (≈ 10–20 draw calls for a full level). Geometry is
 * rebuilt and the previous build disposed whenever `level` (or `options`) changes; shared
 * materials/textures stay cached across levels.
 */
import { useEffect, useMemo } from 'react';
import type { ControlHint, LevelDef } from '@/game/types';
import { buildLevelGeometry, type LevelBuildOptions } from './buildLevel';
import { FloatingHints } from './FloatingHints';

export interface LevelGeometryProps {
  level: LevelDef;
  /** Build options (shadows, supports, zone markers). Compared by value. */
  options?: LevelBuildOptions;
  /** Render floating hint signage. Default true. */
  hints?: boolean;
  /** Maps a hint's control hint to key labels (e.g. current bindings). Default: hint.keys. */
  resolveHintKeys?: (hint: ControlHint) => string[];
}

export function LevelGeometry({ level, options, hints = true, resolveHintKeys }: LevelGeometryProps) {
  const optionsKey = JSON.stringify(options ?? {});
  // options are compared by value (inline objects must not rebuild the level every render)
  const build = useMemo(() => buildLevelGeometry(level, options), [level, optionsKey]);
  useEffect(() => () => build.dispose(), [build]);
  return (
    <>
      <primitive object={build.group} />
      {hints && level.floatingHints.length > 0 && <FloatingHints hints={level.floatingHints} resolveKeys={resolveHintKeys} />}
    </>
  );
}
