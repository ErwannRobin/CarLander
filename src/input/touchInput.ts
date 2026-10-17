/**
 * Module-level touch control state. Written by <TouchControls/> (src/ui), merged into the
 * InputState by InputManager.sample(). Plain mutable object: no React, no allocation.
 */
export interface TouchInputState {
  /** Touch controls are mounted (values below are meaningful). */
  active: boolean;
  /** -1..1 (stick x, only used when tilt steering is unavailable or off). */
  steer: number;
  /** -1..1 (phone tilted like a steering wheel: right = +1). Written by src/input/gyro.ts. */
  tilt: number;
  /** -1..1 (phone tipped forward = gas, back = brake). Written by src/input/gyro.ts. */
  tiltThrottle: number;
  /** -1..1 (GAS / stick y, up = +1; BRAKE = -1). */
  throttle: number;
  /** -1..1 (ROLL L = -1, ROLL R = +1). */
  roll: number;
  boost: boolean;
  /** Vertical booster (JUMP button). */
  jump: boolean;
  vacuum: boolean;
  stabilize: boolean;
}

export const touchInput: TouchInputState = {
  active: false,
  steer: 0,
  tilt: 0,
  tiltThrottle: 0,
  throttle: 0,
  roll: 0,
  boost: false,
  jump: false,
  vacuum: false,
  stabilize: false,
};

/** Camera zoom range: a multiplier of the boom length (< 1 closer, > 1 farther). */
export const ZOOM_MIN = 0.55;
export const ZOOM_MAX = 2.4;

export const clampZoom = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/** Zoom factor for a wheel / trackpad-pinch event (> 1 = zoom out). Trackpad pinches arrive as ctrl+wheel with small deltas. */
export function wheelZoomFactor(e: WheelEvent): number {
  const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
  return Math.exp(e.deltaY * lines * (e.ctrlKey ? 0.01 : 0.0012));
}

/**
 * Free-look offset of the chase camera, set by dragging a finger over the scene and read by
 * CameraRig. `yaw` orbits around the car's up axis (rad, + = camera moves to the car's right),
 * `pitch` raises the camera (rad). Both drift back to 0 shortly after the finger lifts.
 * `zoom` (pinch / wheel) scales the boom length and stays where the player left it.
 */
export const cameraLook = {
  yaw: 0,
  pitch: 0,
  zoom: 1,
  /** A finger is currently dragging. */
  dragging: false,
  /** Seconds since the finger lifted (the camera waits before returning). */
  idle: 0,
};

/** Release every touch control (keeps `active`). */
export function resetTouchInput(): void {
  touchInput.steer = 0;
  touchInput.tilt = 0;
  touchInput.tiltThrottle = 0;
  touchInput.throttle = 0;
  touchInput.roll = 0;
  touchInput.boost = false;
  touchInput.jump = false;
  touchInput.vacuum = false;
  touchInput.stabilize = false;
}

/** Put the free-look camera back behind the car (orbit only: zoom stays, see `resetCameraZoom`). */
export function resetCameraOrbit(): void {
  cameraLook.yaw = 0;
  cameraLook.pitch = 0;
  cameraLook.dragging = false;
  cameraLook.idle = 0;
}

export function resetCameraZoom(): void {
  cameraLook.zoom = 1;
}

/** Orbit and zoom back to the default framing. */
export function resetCameraLook(): void {
  cameraLook.yaw = 0;
  cameraLook.pitch = 0;
  cameraLook.zoom = 1;
  cameraLook.dragging = false;
  cameraLook.idle = 0;
}
