import type RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';

const _a = new Vector3();
const _b = new Vector3();
const _q = new Quaternion();

/**
 * Local mirror of the chassis rigid-body state for one tick.
 *
 * The vehicle reads pose/velocity from Rapier once, applies all of its impulses (suspension,
 * tires, aero, thrust, air control, vacuum…) to this mirror with exact rigid-body math, and
 * writes the resulting velocities back once before `world.step()`. Rapier then integrates
 * gravity, resolves chassis contacts (with CCD) and advances the pose.
 *
 * Mass properties are principal in the chassis frame (as set on the Rapier body), so the world
 * inverse inertia is R · diag(1/I) · Rᵀ.
 */
export class BodyState {
  readonly position = new Vector3();
  readonly quaternion = new Quaternion();
  readonly linvel = new Vector3();
  readonly angvel = new Vector3();
  /** World-space center of mass. */
  readonly com = new Vector3();
  /** Chassis basis in world space. */
  readonly right = new Vector3(1, 0, 0);
  readonly up = new Vector3(0, 1, 0);
  readonly forward = new Vector3(0, 0, -1);

  readonly mass: number;
  readonly invMass: number;
  /** Local principal inverse inertia (1/Ixx, 1/Iyy, 1/Izz). */
  readonly invInertia: Vector3;
  readonly inertia: Vector3;
  readonly localCom: Vector3;

  private readonly inv = new Quaternion();
  private readonly tv = { x: 0, y: 0, z: 0 };
  private readonly tq = { x: 0, y: 0, z: 0, w: 1 };

  constructor(mass: number, inertia: [number, number, number], localCom: [number, number, number]) {
    this.mass = mass;
    this.invMass = 1 / mass;
    this.inertia = new Vector3(...inertia);
    this.invInertia = new Vector3(1 / inertia[0], 1 / inertia[1], 1 / inertia[2]);
    this.localCom = new Vector3(...localCom);
  }

  /** Pulls pose + velocity from the Rapier body (no allocations). */
  read(body: RAPIER.RigidBody): void {
    const t = body.translation(this.tv);
    this.position.set(t.x, t.y, t.z);
    const r = body.rotation(this.tq);
    this.quaternion.set(r.x, r.y, r.z, r.w);
    const lv = body.linvel(this.tv);
    this.linvel.set(lv.x, lv.y, lv.z);
    const av = body.angvel(this.tv);
    this.angvel.set(av.x, av.y, av.z);
    this.updateDerived();
  }

  /** Recomputes basis, CoM and inverse rotation after the pose changed. */
  updateDerived(): void {
    const q = this.quaternion;
    this.inv.copy(q).invert();
    this.right.set(1, 0, 0).applyQuaternion(q);
    this.up.set(0, 1, 0).applyQuaternion(q);
    this.forward.set(0, 0, -1).applyQuaternion(q);
    this.com.copy(this.localCom).applyQuaternion(q).add(this.position);
  }

  /** Pushes velocities to the Rapier body. */
  writeVelocities(body: RAPIER.RigidBody): void {
    const v = this.tv;
    v.x = this.linvel.x;
    v.y = this.linvel.y;
    v.z = this.linvel.z;
    body.setLinvel(v, true);
    v.x = this.angvel.x;
    v.y = this.angvel.y;
    v.z = this.angvel.z;
    body.setAngvel(v, true);
  }

  toLocal(v: Vector3, out: Vector3): Vector3 {
    return out.copy(v).applyQuaternion(this.inv);
  }

  toWorld(v: Vector3, out: Vector3): Vector3 {
    return out.copy(v).applyQuaternion(this.quaternion);
  }

  /** Chassis-local point -> world. */
  pointToWorld(local: Vector3, out: Vector3): Vector3 {
    return out.copy(local).applyQuaternion(this.quaternion).add(this.position);
  }

  /** World point -> chassis local. */
  pointToLocal(world: Vector3, out: Vector3): Vector3 {
    return out.copy(world).sub(this.position).applyQuaternion(this.inv);
  }

  /** out = I_world⁻¹ · v */
  invInertiaMul(v: Vector3, out: Vector3): Vector3 {
    out.copy(v).applyQuaternion(this.inv);
    out.x *= this.invInertia.x;
    out.y *= this.invInertia.y;
    out.z *= this.invInertia.z;
    return out.applyQuaternion(this.quaternion);
  }

  /** Velocity of a world point rigidly attached to the body. */
  velocityAt(point: Vector3, out: Vector3): Vector3 {
    _a.subVectors(point, this.com);
    return out.crossVectors(this.angvel, _a).add(this.linvel);
  }

  /** Effective mass of the body at `point` along unit direction `dir`. */
  effectiveMass(dir: Vector3, point: Vector3): number {
    _a.subVectors(point, this.com);
    _b.crossVectors(_a, dir); // r × d
    const k = this.invMass + this.invInertiaMul(_b, _a).dot(_b);
    return k > 1e-12 ? 1 / k : 0;
  }

  applyLinearImpulse(j: Vector3): void {
    this.linvel.addScaledVector(j, this.invMass);
  }

  /** Impulse along `dir` (unit) with magnitude `mag`, at world `point`. */
  applyImpulseAt(dir: Vector3, mag: number, point: Vector3): void {
    if (mag === 0) return;
    this.linvel.addScaledVector(dir, mag * this.invMass);
    _a.subVectors(point, this.com);
    _b.crossVectors(_a, dir).multiplyScalar(mag);
    this.invInertiaMul(_b, _a);
    this.angvel.add(_a);
  }

  /** World angular impulse (torque · dt). */
  applyAngularImpulse(l: Vector3): void {
    this.invInertiaMul(l, _a);
    this.angvel.add(_a);
  }

  /** Copies another state's kinematic values (for last-good snapshots). */
  copyKinematics(src: BodyState): void {
    this.position.copy(src.position);
    this.quaternion.copy(src.quaternion);
    this.linvel.copy(src.linvel);
    this.angvel.copy(src.angvel);
    this.updateDerived();
  }

  isFinite(): boolean {
    const p = this.position;
    const q = this.quaternion;
    const v = this.linvel;
    const w = this.angvel;
    return (
      Number.isFinite(p.x + p.y + p.z) &&
      Number.isFinite(q.x + q.y + q.z + q.w) &&
      Number.isFinite(v.x + v.y + v.z) &&
      Number.isFinite(w.x + w.y + w.z)
    );
  }
}

/** Rotation that takes unit vector `from` onto unit vector `to`, as an axis·angle vector (world). */
export function rotationVectorBetween(from: Vector3, to: Vector3, out: Vector3): Vector3 {
  out.crossVectors(from, to);
  const s = out.length();
  const c = from.dot(to);
  const angle = Math.atan2(s, c);
  if (s < 1e-9) {
    if (c > 0) return out.set(0, 0, 0);
    // opposite: any perpendicular axis
    out.set(1, 0, 0).cross(from);
    if (out.lengthSq() < 1e-6) out.set(0, 0, 1).cross(from);
    return out.normalize().multiplyScalar(Math.PI);
  }
  return out.multiplyScalar(angle / s);
}

/** Axis·angle vector of the shortest rotation from quaternion `a` to `b` (world frame). */
export function rotationVectorBetweenQuats(a: Quaternion, b: Quaternion, out: Vector3): Vector3 {
  // q_err = b · a⁻¹
  _q.copy(a).invert().premultiply(b);
  if (_q.w < 0) {
    _q.x = -_q.x;
    _q.y = -_q.y;
    _q.z = -_q.z;
    _q.w = -_q.w;
  }
  const s = Math.sqrt(_q.x * _q.x + _q.y * _q.y + _q.z * _q.z);
  if (s < 1e-9) return out.set(0, 0, 0);
  const angle = 2 * Math.atan2(s, _q.w);
  return out.set(_q.x, _q.y, _q.z).multiplyScalar(angle / s);
}
