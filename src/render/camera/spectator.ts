/**
 * Spectator camera for replays: a tripod "trackside" camera that cuts to a new spot ahead of the car
 * whenever it has passed, got too far or lost sight of it, and zooms (telephoto) to keep the car the
 * same size on screen. In the air it waits near the predicted landing point.
 */
import { MathUtils, PerspectiveCamera, Vector3 } from 'three';
import type { RenderFrame } from '@/game/types';
import { cameraServices } from './cameraServices';
import { damp, smoothDampVec3 } from './smoothing';

const WORLD_UP = new Vector3(0, 1, 0);
/** Lateral offsets (m), heights above the ground (m) tried for a new spot, in order of preference. */
const LATERAL = [12, 18, 7];
const HEIGHTS = [1.7, 5, 11];
/** Cut when the car is this far past the camera (m), or farther away than MAX_DIST. */
const PASSED = 10;
const MAX_DIST = 95;
/** Seconds without a clear line of sight before cutting. */
const BLOCKED_CUT = 0.35;
/** Width of the shot (m): the car plus some surroundings. */
const FRAMING = 7.5;
const MIN_FOV = 12;
const MAX_FOV = 58;

const dirH = new Vector3();
const right = new Vector3();
const base = new Vector3();
const cand = new Vector3();
const eye = new Vector3();
const ahead = new Vector3();
const lookAt = new Vector3();
const ray = new Vector3();
const fut = new Vector3();
const rel = new Vector3();

function clear(a: Vector3, b: Vector3): boolean {
  const cast = cameraServices.raycast;
  if (!cast) return true;
  ray.copy(b).sub(a);
  const len = ray.length();
  if (len < 1e-3) return true;
  ray.divideScalar(len);
  const hit = cast(a, ray, len + 0.3);
  return hit === null || hit >= len - 0.2;
}

export class SpectatorCam {
  private readonly anchor = new Vector3();
  private readonly target = new Vector3();
  private readonly targetVel = new Vector3();
  private has = false;
  private blocked = 0;
  private side = 1;
  private fov = 40;
  private runId = -1;

  /** Forget the current spot (replay restarted, or the rig was used by another mode). */
  reset() {
    this.has = false;
    this.blocked = 0;
  }

  update(camera: PerspectiveCamera, f: RenderFrame, runId: number, dt: number) {
    if (runId !== this.runId) {
      this.runId = runId;
      this.reset();
    }
    const snap = f.snapshot;
    const v = snap.vehicle;
    const P = f.position;
    dt = Math.min(0.05, Math.max(1e-4, dt));

    // heading on the ground plane: velocity when moving, else where the nose points
    if (v.speed > 2) dirH.set(v.velocity.x, 0, v.velocity.z);
    else dirH.set(0, 0, -1).applyQuaternion(f.quaternion).setY(0);
    if (dirH.lengthSq() < 1e-6) dirH.set(0, 0, -1);
    dirH.normalize();

    eye.copy(P).addScaledVector(WORLD_UP, 0.6);
    let cut = !this.has;
    if (this.has) {
      const passed = rel.copy(this.anchor).sub(P).dot(dirH) < -PASSED && v.speed > 3;
      const far = this.anchor.distanceTo(P) > MAX_DIST;
      this.blocked = clear(this.anchor, eye) ? 0 : this.blocked + dt;
      cut = passed || far || this.blocked > BLOCKED_CUT;
    }
    if (cut) this.pick(f);

    // aim slightly ahead of the car so fast passes stay framed
    ahead.copy(v.velocity).multiplyScalar(0.1);
    if (ahead.length() > 4) ahead.setLength(4);
    lookAt.copy(P).add(ahead).addScaledVector(WORLD_UP, 0.4);
    if (cut) {
      this.target.copy(lookAt);
      this.targetVel.set(0, 0, 0);
    } else smoothDampVec3(this.target, lookAt, this.targetVel, 0.12, dt);

    // telephoto: the farther the car, the narrower the lens
    const dist = Math.max(3, this.anchor.distanceTo(P));
    const fovTarget = MathUtils.clamp(2 * Math.atan(FRAMING / dist) * MathUtils.RAD2DEG, MIN_FOV, MAX_FOV);
    this.fov = cut ? fovTarget : this.fov + (fovTarget - this.fov) * damp(6, dt);

    camera.position.copy(this.anchor);
    camera.up.copy(WORLD_UP);
    camera.lookAt(this.target);
    if (Math.abs(camera.fov - this.fov) > 0.01) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
  }

  /** Current vertical field of view (so the chase rig can continue from it). */
  get currentFov(): number {
    return this.fov;
  }

  private pick(f: RenderFrame) {
    const snap = f.snapshot;
    const v = snap.vehicle;
    const P = f.position;
    const pred = snap.prediction;
    right.crossVectors(dirH, WORLD_UP).normalize();

    // where the action will be: the landing point while in the air, else a little way down the road
    if (v.airborne && pred && pred.valid && pred.timeToImpact > 0.6) base.copy(pred.point);
    else base.copy(P).addScaledVector(dirH, MathUtils.clamp(v.speed * 1.5, 14, 48));

    const cast = cameraServices.raycast;
    const futureOk = (a: Vector3) => {
      // also keep sight of where the car will be in a moment
      fut.copy(P).addScaledVector(v.velocity, 0.8);
      return clear(a, fut);
    };
    let found = false;
    outer: for (const s of [this.side, -this.side]) {
      for (const lat of LATERAL) {
        // ground under the spot: drop a ray from above, so the camera sits at human height, not car height
        cand.copy(base).addScaledVector(right, s * lat);
        let groundY = cand.y;
        if (cast) {
          ray.set(0, -1, 0);
          eye.copy(cand).setY(cand.y + 40);
          const d = cast(eye, ray, 90);
          if (d !== null) groundY = eye.y - d;
        }
        for (const h of HEIGHTS) {
          this.anchor.copy(cand).setY(groundY + h);
          eye.copy(P).addScaledVector(WORLD_UP, 0.6);
          if (clear(this.anchor, eye) && futureOk(this.anchor)) {
            this.side = -s;
            found = true;
            break outer;
          }
        }
      }
    }
    // nothing has sight of the car: fall back to a high shot from behind
    if (!found) this.anchor.copy(P).addScaledVector(dirH, -12).addScaledVector(WORLD_UP, 6);
    this.has = true;
    this.blocked = 0;
  }
}
