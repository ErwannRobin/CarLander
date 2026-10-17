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
  throttle: 0,
  roll: 0,
  boost: false,
  jump: false,
  vacuum: false,
  stabilize: false,
};

/**
 * Free-look offset of the chase camera, set by dragging a finger over the scene and read by
 * CameraRig. `yaw` orbits around the car's up axis (rad, + = camera moves to the car's right),
 * `pitch` raises the camera (rad). Drifts back to 0 shortly after the finger lifts.
 */
export const cameraLook = {
  yaw: 0,
  pitch: 0,
  /** A finger is currently dragging. */
  dragging: false,
  /** Seconds since the finger lifted (the camera waits before returning). */
  idle: 0,
};

/** Release every touch control (keeps `active`). */
export function resetTouchInput(): void {
  touchInput.steer = 0;
  touchInput.tilt = 0;
  touchInput.throttle = 0;
  touchInput.roll = 0;
  touchInput.boost = false;
  touchInput.jump = false;
  touchInput.vacuum = false;
  touchInput.stabilize = false;
}

/** Put the free-look camera back behind the car. */
export function resetCameraLook(): void {
  cameraLook.yaw = 0;
  cameraLook.pitch = 0;
  cameraLook.dragging = false;
  cameraLook.idle = 0;
}
