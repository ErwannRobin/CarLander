/**
 * Build-once / dispose-on-change helper for Level 1 decor (imperative three.js groups owned by a
 * React component). Disposal frees GPU memory only — a StrictMode re-mount re-uploads.
 */
import { useEffect, useMemo, type DependencyList } from 'react';
import { Mesh, type BufferGeometry, type Material, type Object3D } from 'three';
import type { GeoBuilder } from '@/render/level/geometry/GeoBuilder';

export interface Disposable {
  dispose(): void;
}

export interface Built {
  root: Object3D;
  owned: Disposable[];
}

export function useBuilt<T extends Built>(build: () => T, deps: DependencyList = []): T {
  const built = useMemo(build, deps);
  useEffect(
    () => () => {
      for (const d of built.owned) d.dispose();
    },
    [built],
  );
  return built;
}

/** Mesh from a GeoBuilder (registers the geometry as owned); null when empty. */
export function meshOf(b: GeoBuilder, material: Material, owned: Disposable[], shadows: { cast?: boolean; receive?: boolean } = {}): Mesh | null {
  if (b.isEmpty()) return null;
  const geo: BufferGeometry = b.build();
  owned.push(geo);
  const m = new Mesh(geo, material);
  m.castShadow = shadows.cast ?? true;
  m.receiveShadow = shadows.receive ?? true;
  m.matrixAutoUpdate = false;
  m.updateMatrix();
  return m;
}
