import type { Object3D } from 'three';

const noop = () => {};

/**
 * FX meshes are positioned by custom vertex shaders (billboards, volumes, decals), so CPU raycasts
 * against their placeholder geometry would be meaningless (and slow): opt them out.
 */
export function disableRaycast<T extends Object3D>(object: T): T {
  object.raycast = noop;
  return object;
}
