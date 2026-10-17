/**
 * Tilt steering: the phone is the steering wheel.
 *
 * The wheel angle is the rotation of the phone about the screen normal, read from the direction of
 * gravity in the device frame (so it works whatever the screen orientation and does not suffer from
 * the Euler gimbal flip of `gamma` when the phone is held upright). Turning the phone clockwise as
 * the player sees it steers right. Output goes to `touchInput.tilt`, merged into the steer axis by
 * InputManager.
 *
 * Availability:
 *  - iOS 13+ needs `DeviceOrientationEvent.requestPermission()` from a user gesture: `initGyro()` arms a
 *    one-shot click listener for it.
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

/** Ask for sensor access. Must run inside a user gesture (a click handler). */
export function requestGyro(): void {
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
  if (permissionApi()) {
    setStatus('prompt');
    // the first tap anywhere (title screen, level card…) is the gesture iOS wants
    window.addEventListener('click', requestGyro, { capture: true, once: true });
    window.addEventListener('touchend', requestGyro, { capture: true, once: true });
  } else {
    startListening();
  }
}

/** Switch tilt steering on or off without tearing the sensor listener down (settings, stick fallback). */
export function setGyroEnabled(on: boolean): void {
  enabled = on;
  if (!on) {
    touchInput.tilt = 0;
    smoothed = 0;
  }
}
