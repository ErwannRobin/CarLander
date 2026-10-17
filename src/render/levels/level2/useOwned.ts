import { useEffect, useMemo, type DependencyList } from 'react';
import type { Object3D } from 'three';

export interface OwnedBuild {
  root: Object3D;
  /** GPU resources created by the build (never shared kit materials). */
  owned: { dispose(): void }[];
}

/**
 * Builds three objects once per `deps` change and disposes the previous build's GPU resources.
 * The scene graph is left intact on dispose so a StrictMode re-mount can reuse it.
 */
export function useOwned<T extends OwnedBuild>(build: () => T, deps: DependencyList): T {
  // deps are value-compared by the caller; `build` is a fresh closure each render
  const built = useMemo(build, deps);
  useEffect(
    () => () => {
      for (const d of built.owned) d.dispose();
    },
    [built],
  );
  return built;
}
