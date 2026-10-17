/**
 * Module-level touch control state. Written by <TouchControls/> (src/ui), merged into the
 * InputState by InputManager.sample(). Plain mutable object: no React, no allocation.
 */
export interface TouchInputState {
  /** Touch controls are mounted (values below are meaningful). */
  active: boolean;
  /** -1..1 (stick x). */
  steer: number;
  /** -1..1 (stick y, up = +1). */
  throttle: number;
  /** -1..1 (ROLL L = -1, ROLL R = +1). */
  roll: number;
  boost: boolean;
  vacuum: boolean;
  stabilize: boolean;
}

export const touchInput: TouchInputState = {
  active: false,
  steer: 0,
  throttle: 0,
  roll: 0,
  boost: false,
  vacuum: false,
  stabilize: false,
};

/** Release every touch control (keeps `active`). */
export function resetTouchInput(): void {
  touchInput.steer = 0;
  touchInput.throttle = 0;
  touchInput.roll = 0;
  touchInput.boost = false;
  touchInput.vacuum = false;
  touchInput.stabilize = false;
}
