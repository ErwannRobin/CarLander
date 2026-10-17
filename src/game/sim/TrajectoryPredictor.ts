import { Vector3 } from 'three';
import { createRayHit, type PhysicsWorld, type RayHit } from '../physics/PhysicsWorld';
import { RAD } from '../physics/util';
import type { ZoneTester } from '../track/zones';
import { TUNING } from '../tuning';
import type { LandingPrediction } from '../types';
import { angleBetweenDeg, classifyLanding, driftAngleDeg, impactSpeedAlong } from './LandingEvaluator';

/** The probe follows the car's underside rather than its origin (m below the chassis origin). */
const PROBE_OFFSET = 0.45;

const _p0 = new Vector3();
const _p1 = new Vector3();
const _seg = new Vector3();
const _dir = new Vector3();
const _probe = new Vector3();

export function createLandingPrediction(): LandingPrediction {
  return {
    valid: false,
    point: new Vector3(),
    normal: new Vector3(0, 1, 0),
    timeToImpact: 0,
    alignmentDeg: 0,
    pitchErrorDeg: 0,
    rollErrorDeg: 0,
    predictedQuality: 'clean',
    inTarget: false,
    path: [],
  };
}

/**
 * Ballistic landing prediction (ARCHITECTURE §5): integrates gravity-only motion from the current
 * state with 0.04 s steps up to 6 s, raycasting each segment against static colliders (never the
 * car). Attitude-dependent fields can be refreshed every tick with `updateAttitude` while the
 * (more expensive) path is recomputed every few ticks.
 */
export class TrajectoryPredictor {
  readonly prediction: LandingPrediction = createLandingPrediction();
  /** Velocity at the predicted impact. */
  readonly impactVelocity = new Vector3();
  private readonly pool: Vector3[] = [];
  private readonly hit: RayHit = createRayHit();

  constructor() {
    for (let i = 0; i < TUNING.prediction.maxPoints; i++) this.pool.push(new Vector3());
  }

  reset(): void {
    this.prediction.valid = false;
    this.prediction.path.length = 0;
  }

  /**
   * Recomputes the ballistic path from `position` / `velocity`. Returns `prediction.valid`.
   * @param targetZone zone used for `inTarget` (null = none)
   */
  predict(physics: PhysicsWorld, position: Vector3, velocity: Vector3, targetZone: ZoneTester | null): boolean {
    const P = TUNING.prediction;
    const g = physics.gravity;
    const pred = this.prediction;
    const steps = Math.ceil(P.horizon / P.step);
    const minY = physics.bounds.min.y - 1;
    _probe.copy(position);
    _probe.y -= PROBE_OFFSET;
    let impactT = -1;
    for (let i = 0; i < steps; i++) {
      const t0 = i * P.step;
      const t1 = t0 + P.step;
      ballistic(_probe, velocity, g, t0, _p0);
      ballistic(_probe, velocity, g, t1, _p1);
      if (_p0.y < minY && velocity.y - g * t0 < 0) break; // below all geometry and falling
      _seg.subVectors(_p1, _p0);
      const len = _seg.length();
      if (len < 1e-6) continue;
      _dir.copy(_seg).divideScalar(len);
      const h = physics.raycast(_p0, _dir, len, this.hit, { slot: 20 });
      if (h) {
        impactT = t0 + (h.distance / len) * P.step;
        pred.point.copy(h.point);
        pred.normal.copy(h.normal);
        break;
      }
    }
    if (impactT < 0) {
      pred.valid = false;
      pred.path.length = 0;
      return false;
    }
    pred.valid = true;
    pred.timeToImpact = impactT;
    this.impactVelocity.copy(velocity);
    this.impactVelocity.y -= g * impactT;
    // sampled path from the car's underside to the impact point (≤ maxPoints)
    const n = Math.max(2, Math.min(P.maxPoints, Math.ceil(impactT / P.step) + 1));
    pred.path.length = n;
    for (let k = 0; k < n; k++) {
      const v = this.pool[k];
      ballistic(_probe, velocity, g, (impactT * k) / (n - 1), v);
      pred.path[k] = v;
    }
    pred.path[n - 1].copy(pred.point);
    pred.inTarget = targetZone ? targetZone.contains(_p0.copy(pred.point).addScaledVector(pred.normal, 0.5), 0.5) : false;
    return true;
  }

  /** Refreshes alignment / attitude errors / predicted quality for the current attitude. */
  updateAttitude(up: Vector3, forward: Vector3, right: Vector3): void {
    const pred = this.prediction;
    if (!pred.valid) return;
    const n = pred.normal;
    pred.alignmentDeg = angleBetweenDeg(up, n);
    // +pitch = nose too high (forward points away from the surface), +roll = rolled right (right side low)
    pred.pitchErrorDeg = Math.asin(Math.max(-1, Math.min(1, forward.dot(n)))) * RAD;
    pred.rollErrorDeg = Math.asin(Math.max(-1, Math.min(1, -right.dot(n)))) * RAD;
    if (up.dot(n) < 0) {
      // inverted: express the roll error beyond ±90° so the indicator shows the long way round
      pred.rollErrorDeg = pred.rollErrorDeg >= 0 ? 180 - pred.rollErrorDeg : -180 - pred.rollErrorDeg;
    }
    pred.predictedQuality = classifyLanding({
      angleDeg: pred.alignmentDeg,
      impactSpeed: impactSpeedAlong(this.impactVelocity, n),
      driftDeg: driftAngleDeg(forward, this.impactVelocity, n),
      wheelsDown: 4,
      chassisHit: false,
    });
  }
}

function ballistic(p: Vector3, v: Vector3, g: number, t: number, out: Vector3): Vector3 {
  out.set(p.x + v.x * t, p.y + v.y * t - 0.5 * g * t * t, p.z + v.z * t);
  return out;
}
