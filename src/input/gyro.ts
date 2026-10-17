/**
 * Tilt steering: the phone is the steering wheel.
 *
 * The wheel angle is the rotation of the phone about the screen normal, read from the direction of
 * gravity in the device frame (so it works whatever the screen orientation and does not suffer from
 * the Euler gimbal flip of `gamma` when the phone is held upright). Turning the phone clockwise as
 * the player sees it steers right. Output goes to `touchInput.tilt`, merged into the steer axis by
 * InputManager.
 *
 * Gas and brake come from the same sensor: tipping the top of the phone away from the player is gas,
 * tipping it toward the player is brake. The neutral pose is wherever the phone was held when
 * `calibrateTilt()` last ran (each run calls it when its 3-2-1 countdown reaches GO), so any comfortable
 * grip works. Output goes to `touchInput.tiltThrottle`.
 *
 * Availability:
 *  - iOS 13+ needs `DeviceOrientationEvent.requestPermission()` from a user gesture: the Play button calls
 *    `requestGyro()`.
 *  - Elsewhere, listening starts right away. Browsers only deliver the sensor on secure contexts
 *    (https or localhost), and desktops fire one event with null angles: if no real reading arrives
 *    within a moment the status becomes 'unsupported' and the UI falls back to the on-screen stick.
 */
import { touchInput } from './touchInput';

export type GyroStatus =
  /** initGyro() has not run. */
  | 'idle'
  /** Waiting for a user gesture to ask for sensor access (iOS). */
  | 'prompt'
  /** Listening, no reading yet. */
  | 'listening'
  /** Readings are arriving. */
  | 'active'
  /** No sensor, or no readings (desktop, insecure page). */
  | 'unsupported'
  /** The player refused sensor access. */
  | 'denied';

/** Wheel angle (deg) for full lock, and the dead band around straight ahead. */
const FULL_LOCK_DEG = 32;
const DEADZONE_DEG = 2.5;
/** Gas / brake: dead band around the calibrated pose, and the tilt (deg) that gives full gas or full brake. */
const THROTTLE_DEADZONE_DEG = 5;
const THROTTLE_FULL_DEG = 20;
/** Phones lying nearly flat have no meaningful wheel angle: below this in-plane gravity share we hold. */
const MIN_IN_PLANE = 0.22;
/** Low-pass factor per sensor event (~60 Hz): about 35 ms of lag. */
const SMOOTHING = 0.38;
/** How long to wait for a first real reading before giving up. */
const NO_READING_MS = 1500;
const DEG = Math.PI / 180;

interface PermissionedEvent {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

let status: GyroStatus = 'idle';
let enabled = true;
let listening = false;
let requesting = false;
let giveUpTimer = 0;
let smoothed = 0;
let lastAngle = 0;
let smoothedPitch = 0;
let pitchSeen = false;
/** Pitch (deg) held as "neutral"; null until the first reading or calibrateTilt(). */
let neutralPitch: number | null = null;
const listeners = new Set<() => void>();

function setStatus(next: GyroStatus): void {
  if (next === status) return;
  status = next;
  for (const l of [...listeners]) l();
}

export const getGyroStatus = (): GyroStatus => status;

export function subscribeGyro(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Wheel angle in degrees (+ = turned clockwise as the player sees the screen) from W3C
 * DeviceOrientation angles and the screen orientation angle (0, 90, 180, 270).
 * Returns null when the phone is too flat for the angle to mean anything.
 */
export function tiltAngleDeg(betaDeg: number, gammaDeg: number, screenAngleDeg: number): number | null {
  const b = betaDeg * DEG;
  const g = gammaDeg * DEG;
  // direction of "up" (against gravity) in the device frame: third row of Rz(alpha) Rx(beta) Ry(gamma)
  const ux = -Math.cos(b) * Math.sin(g);
  const uy = Math.sin(b);
  // the same vector on the screen axes (screen right / screen up expressed in device coordinates)
  const s = screenAngleDeg * DEG;
  const sx = ux * Math.cos(s) - uy * Math.sin(s);
  const sy = ux * Math.sin(s) + uy * Math.cos(s);
  if (Math.hypot(sx, sy) < MIN_IN_PLANE) return null;
  return Math.atan2(-sx, sy) / DEG;
}

/** Wheel angle (deg) → steer axis (-1..1): dead band, full lock at FULL_LOCK_DEG, mild expo. */
export function steerFromTiltDeg(deg: number): number {
  const a = Math.abs(deg);
  if (a <= DEADZONE_DEG) return 0;
  const n = Math.min(1, (a - DEADZONE_DEG) / (FULL_LOCK_DEG - DEADZONE_DEG));
  return Math.sign(deg) * n * (0.55 + 0.45 * n);
}

/**
 * How far the screen faces up, in degrees from "vertical" (0 = held upright in front of the player,
 * + = top of the phone tipped away from the player, − = tipped toward the player), from W3C
 * DeviceOrientation angles. Independent of the screen orientation.
 */
export function pitchAngleDeg(betaDeg: number, gammaDeg: number): number {
  // component of "up" (against gravity) along the screen normal: third row of Rz(alpha) Rx(beta) Ry(gamma)
  const uz = Math.cos(betaDeg * DEG) * Math.cos(gammaDeg * DEG);
  return Math.asin(Math.max(-1, Math.min(1, uz))) / DEG;
}

/** Tilt away from the neutral pose (deg, + = forward) → throttle axis (−1 brake .. +1 gas): dead band, mild expo. */
export function throttleFromPitchDeg(deltaDeg: number): number {
  const a = Math.abs(deltaDeg);
  if (a <= THROTTLE_DEADZONE_DEG) return 0;
  const n = Math.min(1, (a - THROTTLE_DEADZONE_DEG) / (THROTTLE_FULL_DEG - THROTTLE_DEADZONE_DEG));
  return Math.sign(deltaDeg) * n * (0.5 + 0.5 * n);
}

/** Take the current pose as "neutral" (no gas, no brake). Call when the player is ready to drive. */
export function calibrateTilt(): void {
  if (pitchSeen) neutralPitch = smoothedPitch;
  else neutralPitch = null; // the first reading becomes neutral
  touchInput.tiltThrottle = 0;
}

function screenAngle(): number {
  try {
    const a = screen.orientation?.angle;
    if (typeof a === 'number') return a;
  } catch {
    /* ignore */
  }
  // iOS Safari before 16.4
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === 'number' ? ((legacy % 360) + 360) % 360 : 0;
}

function onOrientation(e: DeviceOrientationEvent): void {
  if (e.beta === null || e.gamma === null || !Number.isFinite(e.beta) || !Number.isFinite(e.gamma)) return;
  if (giveUpTimer) {
    window.clearTimeout(giveUpTimer);
    giveUpTimer = 0;
  }
  setStatus('active');
  const angle = tiltAngleDeg(e.beta, e.gamma, screenAngle());
  if (angle !== null) lastAngle = angle;
  smoothed += (steerFromTiltDeg(lastAngle) - smoothed) * SMOOTHING;
  touchInput.tilt = enabled ? smoothed : 0;

  const pitch = pitchAngleDeg(e.beta, e.gamma);
  if (!pitchSeen) {
    pitchSeen = true;
    smoothedPitch = pitch;
  } else smoothedPitch += (pitch - smoothedPitch) * SMOOTHING;
  neutralPitch ??= smoothedPitch;
  touchInput.tiltThrottle = enabled ? throttleFromPitchDeg(smoothedPitch - neutralPitch) : 0;
}

function startListening(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('deviceorientation', onOrientation);
  setStatus('listening');
  giveUpTimer = window.setTimeout(() => {
    giveUpTimer = 0;
    if (status === 'listening') setStatus('unsupported');
  }, NO_READING_MS);
}

function permissionApi(): PermissionedEvent | null {
  const api = (typeof DeviceOrientationEvent !== 'undefined' ? DeviceOrientationEvent : null) as unknown as PermissionedEvent | null;
  return api && typeof api.requestPermission === 'function' ? api : null;
}

/**
 * Ask for sensor access. Must run inside a user gesture (the Play button's click handler). On iOS this
 * shows the system prompt; elsewhere there is nothing to ask and it just makes sure the sensor is
 * being read. Safe to call repeatedly: it does nothing once the answer is known.
 */
export function requestGyro(): void {
  if (status === 'idle') initGyro();
  const api = permissionApi();
  if (!api || status !== 'prompt' || requesting) return;
  requesting = true;
  api
    .requestPermission?.()
    .then((result) => {
      if (result === 'granted') startListening();
      else setStatus('denied');
    })
    .catch(() => setStatus('denied'))
    .finally(() => {
      requesting = false;
    });
}

/** Prepare tilt steering on touch devices. Safe to call more than once. */
export function initGyro(): void {
  if (status !== 'idle') return;
  if (typeof window === 'undefined' || typeof DeviceOrientationEvent === 'undefined') {
    setStatus('unsupported');
    return;
  }
  // iOS: wait for requestGyro() from a tap (the Play button); elsewhere the sensor needs no permission
  if (permissionApi()) setStatus('prompt');
  else startListening();
}

/** Switch tilt steering on or off without tearing the sensor listener down (settings, stick fallback). */
export function setGyroEnabled(on: boolean): void {
  enabled = on;
  if (!on) {
    touchInput.tilt = 0;
    touchInput.tiltThrottle = 0;
    smoothed = 0;
  }
}
