import { Vector3 } from 'three';
import { createVacuumState } from '../snapshot';
import { TUNING } from '../tuning';
import type { GameEvent, VacuumMode, VacuumState } from '../types';
import { VACUUM_SKIRT } from '../vehicleSpec';
import { rotationVectorBetween, type BodyState } from './BodyState';
import { createRayHit, type PhysicsWorld, type RayHit } from './PhysicsWorld';

/** Skirt ray origins (chassis local): center + 4 corners. */
const SKIRT_POINTS: ReadonlyArray<Vector3> = [
  new Vector3(0, VACUUM_SKIRT.y, 0),
  new Vector3(-VACUUM_SKIRT.halfWidth, VACUUM_SKIRT.y, -VACUUM_SKIRT.halfLength),
  new Vector3(VACUUM_SKIRT.halfWidth, VACUUM_SKIRT.y, -VACUUM_SKIRT.halfLength),
  new Vector3(-VACUUM_SKIRT.halfWidth, VACUUM_SKIRT.y, VACUUM_SKIRT.halfLength),
  new Vector3(VACUUM_SKIRT.halfWidth, VACUUM_SKIRT.y, VACUUM_SKIRT.halfLength),
];
/** Ray-smoothing warm-start slots used by the skirt rays (wheels use 0..3). */
const SLOT_BASE = 8;

const _origin = new Vector3();
const _dir = new Vector3();
const _n = new Vector3();
const _err = new Vector3();
const _wPerp = new Vector3();
const _alpha = new Vector3();

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export interface VacuumStepInput {
  /** Vacuum button held this tick. */
  held: boolean;
  /** Wheels in contact this tick (alignment torque only assists below 3). */
  groundedWheels: number;
  dt: number;
}

/**
 * Vacuum adhesion system (ARCHITECTURE §5).
 *
 * While held, five skirt rays are cast along chassis −up against ADHESIVE colliders only.
 * The distance-weighted normal n and nearest distance d drive a suction force applied at the
 * center of mass (gravity is never modified):
 *
 *   F = −n · m · G · suctionG(n) · falloff(d) · strength
 *
 * `suctionG` equals `vacuumPeakG` on a ceiling and scales down with the share of gravity that
 * already presses the car into the surface (wall: `wallG`, floor: `floorG`), so the springs carry
 * ≈ (peakG − 1) g everywhere instead of slamming the car on normal floors.
 * `strength` ramps toward its target (≈ 8/s engage, ≈ 14/s release) so attachment and release are
 * never snappy: on release the force fades within ≈ 0.07 s and gravity/momentum take over.
 *
 * With fewer than 3 wheels grounded and suction engaged, a clamped PD alignment torque rotates
 * the chassis up toward n — it assists the catch; the suspension does the rest once wheels touch.
 */
export class VacuumSystem {
  readonly state: VacuumState;
  /** Last applied suction force (world, N) — debug / visuals. */
  readonly force = new Vector3();

  private held = false;
  private readonly lastNormal = new Vector3(0, 1, 0);
  private lastDistance = Infinity;
  private readonly hits: RayHit[] = SKIRT_POINTS.map(() => createRayHit());

  constructor(
    private readonly physics: PhysicsWorld,
    available: boolean,
    state?: VacuumState,
  ) {
    this.state = state ?? createVacuumState(available);
    this.reset(available);
  }

  reset(available = this.state.available): void {
    const s = this.state;
    s.available = available;
    s.mode = 'off';
    s.strength = 0;
    s.distance = Infinity;
    s.hasSurface = false;
    s.surfacePoint.set(0, 0, 0);
    s.surfaceNormal.set(0, 1, 0);
    this.held = false;
    this.lastNormal.set(0, 1, 0);
    this.lastDistance = Infinity;
    this.force.set(0, 0, 0);
  }

  /** Suction in multiples of g for a surface normal (see class doc). */
  static suctionG(normal: Vector3): number {
    const ny = normal.y;
    const v = TUNING.vacuum;
    return ny <= 0
      ? v.wallG + (TUNING.vacuumPeakG - v.wallG) * Math.min(1, -ny)
      : v.wallG + (v.floorG - v.wallG) * Math.min(1, ny);
  }

  /**
   * Senses surfaces, updates mode/strength, applies suction (+ alignment) impulses to `body`.
   * Call once per tick before the body velocities are written back to Rapier.
   */
  step(input: VacuumStepInput, body: BodyState, events: GameEvent[]): void {
    const s = this.state;
    const held = s.available && input.held;
    const prevMode: VacuumMode = s.mode;

    if (held !== this.held) {
      events.push({ type: held ? 'vacuumOn' : 'vacuumOff' });
      this.held = held;
    }

    // ---- sensing ----------------------------------------------------
    s.hasSurface = false;
    s.distance = Infinity;
    if (held) this.sense(body);

    // ---- mode & strength ---------------------------------------------
    const mode: VacuumMode = !held ? 'off' : s.hasSurface ? 'engaged' : 'armed';
    s.mode = mode;
    const target = mode === 'engaged' ? 1 : 0;
    const rate = target > s.strength ? TUNING.vacuum.engageRate : TUNING.vacuum.releaseRate;
    const maxStep = rate * input.dt;
    s.strength += Math.max(-maxStep, Math.min(maxStep, target - s.strength));
    if (s.strength < 1e-4) s.strength = 0;

    if (mode === 'engaged' && prevMode !== 'engaged') {
      events.push({ type: 'vacuumEngaged', position: body.position.clone(), normal: s.surfaceNormal.clone() });
    } else if (prevMode === 'engaged' && mode !== 'engaged') {
      events.push({ type: 'vacuumReleased', position: body.position.clone() });
    }

    // ---- suction force at the CoM ---------------------------------------
    this.force.set(0, 0, 0);
    if (s.strength <= 0) return;
    const n = this.lastNormal;
    const d = this.lastDistance;
    const falloff = 1 - smoothstep(TUNING.vacuum.fullRange, TUNING.vacuumRange, d);
    if (falloff <= 0) return;
    const accel = this.physics.gravity * VacuumSystem.suctionG(n) * falloff * s.strength;
    this.force.copy(n).multiplyScalar(-accel * body.mass);
    body.linvel.addScaledVector(n, -accel * input.dt);

    // ---- alignment assist (only while catching: < 3 wheels down) -------------
    if (mode === 'engaged' && input.groundedWheels < 3) {
      const v = TUNING.vacuum;
      rotationVectorBetween(body.up, n, _err);
      _wPerp.copy(body.angvel).addScaledVector(n, -body.angvel.dot(n));
      _alpha
        .copy(_err)
        .multiplyScalar(v.alignKp)
        .addScaledVector(_wPerp, -v.alignKd)
        .multiplyScalar(s.strength);
      const a = _alpha.length();
      if (a > v.alignMaxAccel) _alpha.multiplyScalar(v.alignMaxAccel / a);
      body.angvel.addScaledVector(_alpha, input.dt);
    }
  }

  private sense(body: BodyState): void {
    const s = this.state;
    _dir.copy(body.up).negate();
    _n.set(0, 0, 0);
    let nearest = Infinity;
    let nearestIdx = -1;
    for (let i = 0; i < SKIRT_POINTS.length; i++) {
      body.pointToWorld(SKIRT_POINTS[i], _origin);
      const hit = this.physics.raycast(_origin, _dir, TUNING.vacuumRange, this.hits[i], {
        adhesiveOnly: true,
        slot: SLOT_BASE + i,
      });
      if (!hit) continue;
      // distance-weighted: close samples dominate the averaged normal
      const w = 1 / ((0.25 + hit.distance) * (0.25 + hit.distance));
      _n.addScaledVector(hit.normal, w);
      if (hit.distance < nearest) {
        nearest = hit.distance;
        nearestIdx = i;
      }
    }
    if (nearestIdx < 0 || _n.lengthSq() < 1e-10) return;
    _n.normalize();
    s.hasSurface = true;
    s.distance = nearest;
    s.surfaceNormal.copy(_n);
    s.surfacePoint.copy(this.hits[nearestIdx].point);
    this.lastNormal.copy(_n);
    this.lastDistance = nearest;
  }
}
