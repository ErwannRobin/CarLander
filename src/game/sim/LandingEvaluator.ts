import { Vector3 } from 'three';
import { RAD } from '../physics/util';
import { TUNING } from '../tuning';
import type { LandingQuality } from '../types';

/** Raw touchdown measurements (ARCHITECTURE §6). */
export interface TouchdownSample {
  /** Angle between chassis up and the surface normal (deg). */
  angleDeg: number;
  /** Speed into the surface along its normal, from the pre-contact velocity (m/s, ≥ 0). */
  impactSpeed: number;
  /** Heading vs velocity in the surface plane (deg); 0 when the tangential speed is below the threshold. */
  driftDeg: number;
  /** Distinct wheels that touched within the touchdown window. */
  wheelsDown: number;
  /** Any chassis (body) contact during the touchdown window. */
  chassisHit: boolean;
}

const RANK: Record<LandingQuality, number> = { crash: 0, hard: 1, clean: 2, perfect: 3 };

/** Ordering helper: perfect 3 > clean 2 > hard 1 > crash 0. */
export function landingRank(q: LandingQuality): number {
  return RANK[q];
}

/**
 * Deterministic landing classification (thresholds in TUNING.landing):
 *
 * | Quality | Angle | Impact | Drift | Notes                                   |
 * |---------|-------|--------|-------|-----------------------------------------|
 * | PERFECT | ≤ 9°  | ≤ 8    | ≤ 9°  | ≥ 3 wheels within 0.15 s, no chassis hit |
 * | CLEAN   | ≤ 24° | ≤ 14   | ≤ 28° |                                         |
 * | HARD    | ≤ 50° | ≤ 24   | ≤ 70° | survived                                |
 * | CRASH   | otherwise                                                         |
 */
export function classifyLanding(s: TouchdownSample): LandingQuality {
  const L = TUNING.landing;
  const fits = (t: { angleDeg: number; impact: number; driftDeg: number }) =>
    s.angleDeg <= t.angleDeg && s.impactSpeed <= t.impact && s.driftDeg <= t.driftDeg;
  if (fits(L.perfect) && s.wheelsDown >= L.perfectMinWheels && !s.chassisHit) return 'perfect';
  if (fits(L.clean)) return 'clean';
  if (fits(L.hard)) return 'hard';
  return 'crash';
}

const _ft = new Vector3();
const _vt = new Vector3();

/** Angle (deg) between two unit vectors. */
export function angleBetweenDeg(a: Vector3, b: Vector3): number {
  return Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * RAD;
}

/** Speed into a surface (≥ 0) for a velocity and the surface's outward normal. */
export function impactSpeedAlong(velocity: Vector3, normal: Vector3): number {
  return Math.max(0, -velocity.dot(normal));
}

/**
 * Drift angle (deg) between the chassis heading and the velocity, both projected on the surface
 * plane. Returns 0 when the tangential speed is below TUNING.landing.driftMinSpeed.
 */
export function driftAngleDeg(forward: Vector3, velocity: Vector3, normal: Vector3): number {
  _vt.copy(velocity).addScaledVector(normal, -velocity.dot(normal));
  if (_vt.length() <= TUNING.landing.driftMinSpeed) return 0;
  _ft.copy(forward).addScaledVector(normal, -forward.dot(normal));
  if (_ft.lengthSq() < 1e-6) return 90; // nose pointing straight into / away from the surface
  return angleBetweenDeg(_ft.normalize(), _vt.normalize());
}

/** Measures a touchdown sample from the car attitude, pre-contact velocity and surface normal. */
export function measureTouchdown(
  up: Vector3,
  forward: Vector3,
  preContactVelocity: Vector3,
  normal: Vector3,
  wheelsDown: number,
  chassisHit: boolean,
): TouchdownSample {
  return {
    angleDeg: angleBetweenDeg(up, normal),
    impactSpeed: impactSpeedAlong(preContactVelocity, normal),
    driftDeg: driftAngleDeg(forward, preContactVelocity, normal),
    wheelsDown,
    chassisHit,
  };
}
