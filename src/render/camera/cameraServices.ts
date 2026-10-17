import type { Vector3 } from 'three';

/**
 * Services the camera needs from the simulation, injected by the game controller so the camera
 * stays decoupled from physics internals.
 */
export const cameraServices: {
  /** Distance to the first static hit along a ray, or null. Must exclude the car. */
  raycast: ((origin: Vector3, dir: Vector3, maxDist: number) => number | null) | null;
  /** Camera shake enabled (settings). */
  shake: boolean;
  /** True while the level intro fly-in should play (set on level load, cleared by the rig). */
  introPending: boolean;
} = {
  raycast: null,
  shake: true,
  introPending: false,
};
