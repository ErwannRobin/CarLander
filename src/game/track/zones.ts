import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { BoxPieceDef, V3, ZoneDef } from '../types';

const DEG = Math.PI / 180;

/** three.js Euler from a `[x, y, z]` degrees triple, order 'YXZ' (yaw, then pitch, then roll about +Z). */
export function eulerDeg(rot?: V3): Euler {
  const r = rot ?? [0, 0, 0];
  return new Euler(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'YXZ');
}

export function quatFromRotationDeg(rot?: V3): Quaternion {
  return new Quaternion().setFromEuler(eulerDeg(rot));
}

/** World matrix of an oriented box (zone or box piece). */
export function boxMatrix(center: V3, rotationDeg?: V3): Matrix4 {
  return new Matrix4().compose(new Vector3(...center), quatFromRotationDeg(rotationDeg), new Vector3(1, 1, 1));
}

/** Precomputed zone tester. */
export class ZoneTester {
  readonly zone: ZoneDef;
  private inv: Matrix4;
  private tmp = new Vector3();
  constructor(zone: ZoneDef) {
    this.zone = zone;
    this.inv = boxMatrix(zone.center, zone.rotationDeg).invert();
  }
  contains(p: Vector3, margin = 0): boolean {
    const l = this.tmp.copy(p).applyMatrix4(this.inv);
    const h = this.zone.halfSize;
    return Math.abs(l.x) <= h[0] + margin && Math.abs(l.y) <= h[1] + margin && Math.abs(l.z) <= h[2] + margin;
  }
  /** Normalized distance from the zone center in its local XZ plane (0 = center, 1 = edge). */
  radial(p: Vector3): number {
    const l = this.tmp.copy(p).applyMatrix4(this.inv);
    const h = this.zone.halfSize;
    return Math.max(Math.abs(l.x) / h[0], Math.abs(l.z) / h[2]);
  }
}

export function pointInZone(zone: ZoneDef, p: Vector3, margin = 0): boolean {
  return new ZoneTester(zone).contains(p, margin);
}

/** World-space top surface center of a box piece (for spawning on platforms). */
export function boxTopCenter(box: BoxPieceDef): Vector3 {
  const q = quatFromRotationDeg(box.rotationDeg);
  return new Vector3(...box.center).add(new Vector3(0, box.size[1] / 2, 0).applyQuaternion(q));
}
