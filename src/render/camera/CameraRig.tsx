/**
 * Cinematic chase camera.
 *
 * Principles: spatial awareness first. On the ground the camera's up vector follows the driving
 * surface (so steering stays screen-consistent even upside down on the vacuum track); in the air it
 * returns to world-up and frames the *trajectory* (heading from velocity, not from the spinning car),
 * biased toward the predicted landing point. Crash: the camera lets go and watches. Level complete:
 * slow orbit. Restart: hard snap (no swoop) so retries are instant.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { CAMERA_PRIORITY, runtime } from '@/game/runtime';
import { cameraLook, clampZoom, resetCameraOrbit, wheelZoomFactor } from '@/input/touchInput';
import { useAppStore } from '@/state/appStore';
import { cameraServices } from './cameraServices';
import { damp, noise1, smoothDampVec3, smoothstep } from './smoothing';

const WORLD_UP = new Vector3(0, 1, 0);
const DEG = Math.PI / 180;
/** Boom lifts (m along the camera up) tried when the line of sight to the car is blocked. */
const LIFTS = [1.5, 3, 5, 8];
/** Never pull the camera closer than this to the car focus (inside the body = black frames). */
const MIN_BOOM = 3.2;
/** Free look (touch drag): seconds the camera stays where it was left, and the lowest / highest boom elevation (rad). */
const LOOK_HOLD = 2;
const LOOK_MIN_ELEV = -0.12;
const LOOK_MAX_ELEV = 1.3;

type Mode = 'chase' | 'intro' | 'crash' | 'complete';

// scratch
const carUp = new Vector3();
const carFwd = new Vector3();
const velDir = new Vector3();
const refUp = new Vector3();
const h = new Vector3();
const desired = new Vector3();
const lookTarget = new Vector3();
const carFocus = new Vector3();
const tmp = new Vector3();
const tmp2 = new Vector3();
const camRight = new Vector3();
const shakeOffset = new Vector3();
const rollQ = new Quaternion();
const viewDir = new Vector3();
const boomDir = new Vector3();
const upAxis = new Vector3();
const upQ = new Quaternion();
const candidate = new Vector3();

/** True when nothing static blocks the segment a→b (with a small margin at b). */
function clearLine(ray: NonNullable<typeof cameraServices.raycast>, a: Vector3, b: Vector3): boolean {
  boomDir.copy(b).sub(a);
  const len = boomDir.length();
  if (len < 1e-3) return true;
  boomDir.divideScalar(len);
  const hit = ray(a, boomDir, len + 0.5);
  return hit === null || hit >= len + 0.3;
}

export function CameraRig() {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const size = useThree((s) => s.size);
  const st = useRef({
    mode: 'chase' as Mode,
    pos: new Vector3(0, 6, 12),
    vel: new Vector3(),
    target: new Vector3(),
    targetVel: new Vector3(),
    up: new Vector3(0, 1, 0),
    heading: new Vector3(0, 0, -1),
    fov: 62,
    trauma: 0,
    punch: 0,
    crashAnchor: new Vector3(),
    crashTime: 0,
    orbit: 0,
    introT: 0,
    introDur: 0,
    introFrom: new Vector3(),
    introLook: new Vector3(),
    initialized: false,
    collideDist: Infinity,
    lift: 0,
    shakeTime: 0,
  });

  useEffect(() => {
    const s = st.current;
    const offs = [
      runtime.events.on('reset', () => {
        s.mode = 'chase';
        s.initialized = false;
        s.trauma = 0;
        resetCameraOrbit(); // the zoom is the player's choice and stays
      }),
      runtime.events.on('crash', () => {
        s.mode = 'crash';
        s.crashAnchor.copy(camera.position);
        s.crashTime = 0;
        s.trauma = Math.min(1, s.trauma + 0.9);
      }),
      runtime.events.on('levelComplete', () => {
        s.mode = 'complete';
        tmp.copy(camera.position).sub(runtime.frame.position);
        s.orbit = Math.atan2(tmp.z, tmp.x);
      }),
      runtime.events.on('landing', (e) => {
        const r = e.result;
        if (r.quality === 'perfect') s.punch = 1;
        s.trauma = Math.min(1, s.trauma + Math.min(0.7, r.impactSpeed / 30) + (r.quality === 'hard' ? 0.25 : 0));
      }),
      runtime.events.on('wheelSlam', (e) => (s.trauma = Math.min(1, s.trauma + e.strength * 0.35))),
      runtime.events.on('impact', (e) => (s.trauma = Math.min(1, s.trauma + e.strength * 0.5))),
      runtime.events.on('boostStart', () => (s.trauma = Math.min(1, s.trauma + 0.12))),
      runtime.events.on('jumpStart', () => (s.trauma = Math.min(1, s.trauma + 0.1))),
      runtime.events.on('vacuumEngaged', () => (s.trauma = Math.min(1, s.trauma + 0.15))),
    ];
    // mouse wheel / trackpad pinch zoom the boom
    const onWheel = (e: WheelEvent) => {
      const app = useAppStore.getState();
      if (app.screen !== 'playing' || app.overlay !== 'none') return;
      e.preventDefault();
      cameraLook.zoom = clampZoom(cameraLook.zoom * wheelZoomFactor(e));
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      offs.forEach((o) => o());
      window.removeEventListener('wheel', onWheel);
    };
  }, [camera]);

  useFrame(() => {
    const s = st.current;
    const f = runtime.frame;
    const snap = f.snapshot;
    const v = snap.vehicle;
    const dt = Math.min(0.05, Math.max(1e-4, f.dt));
    const P = f.position;

    carUp.set(0, 1, 0).applyQuaternion(f.quaternion);
    carFwd.set(0, 0, -1).applyQuaternion(f.quaternion);
    const speed = v.speed;
    if (speed > 0.5) velDir.copy(v.velocity).divideScalar(speed);
    else velDir.copy(carFwd);

    const grounded = v.groundedWheels >= 2 && !v.airborne;
    const engagedNear = v.vacuum.mode === 'engaged' && v.vacuum.hasSurface && v.vacuum.distance < 2.5;

    // ---------------- reference up ----------------
    if (grounded) refUp.copy(carUp);
    else if (engagedNear) refUp.copy(v.vacuum.surfaceNormal);
    else {
      refUp.copy(WORLD_UP);
      // about to land on a slope: pre-align with the predicted surface so the boom clears the hill
      const p = snap.prediction;
      if (v.airborne && p && p.valid && p.normal.y > 0.35) {
        const k = 0.8 * smoothstep(1.4, 0.35, p.timeToImpact);
        if (k > 0) refUp.lerp(p.normal, k).normalize();
      }
    }

    if (!s.initialized) {
      s.up.copy(refUp);
      s.heading.copy(carFwd).projectOnPlane(s.up);
      if (s.heading.lengthSq() < 1e-6) s.heading.set(0, 0, -1);
      s.heading.normalize();
    }

    // rotate (not lerp) toward the reference up: leaving an inverted surface swings the boom around
    // the car through the side instead of collapsing through it; big differences turn faster so the
    // horizon is back quickly for the reorientation
    {
      const ang = s.up.angleTo(refUp);
      if (ang > 1e-4) {
        upAxis.crossVectors(s.up, refUp);
        if (upAxis.lengthSq() < 1e-8) upAxis.copy(s.heading);
        upAxis.normalize();
        const rate = grounded || engagedNear ? 4.5 : ang > Math.PI / 2 ? 3.6 : 2.2;
        upQ.setFromAxisAngle(upAxis, ang * damp(rate, dt));
        s.up.applyQuaternion(upQ);
      }
      if (s.up.lengthSq() < 1e-6) s.up.copy(WORLD_UP);
      s.up.normalize();
    }

    // ---------------- heading ----------------
    if (grounded) {
      h.copy(carFwd);
      if (speed > 6 && v.forwardSpeed > 0) h.lerp(velDir, 0.35);
    } else if (speed > 3) {
      h.copy(velDir);
    } else {
      h.copy(s.heading);
    }
    h.projectOnPlane(s.up);
    if (h.lengthSq() < 1e-4) {
      // velocity (nearly) parallel to up (vertical climb/fall): keep previous heading
      h.copy(s.heading).projectOnPlane(s.up);
      if (h.lengthSq() < 1e-4) h.copy(carFwd).projectOnPlane(s.up);
    }
    h.normalize();
    if (!s.initialized) s.heading.copy(h);
    s.heading.lerp(h, damp(grounded ? 6 : 2.4, dt)).projectOnPlane(s.up);
    if (s.heading.lengthSq() < 1e-6) s.heading.copy(h);
    s.heading.normalize();

    // ---------------- chase framing ----------------
    const sf = smoothstep(8, 75, speed);
    const air = v.airborne ? 1 : 0;
    // portrait screens: pull back and widen so the horizontal field of view stays usable
    const portrait = smoothstep(1.05, 0.5, size.width / Math.max(1, size.height));
    const dist = (6.3 + 1.9 * sf + 2.0 * air + v.boostLevel * 0.9) * (1 + 0.3 * portrait);
    const height = (1.8 + 0.5 * sf + 1.1 * air) * (1 + 0.3 * portrait);
    carFocus.copy(P).addScaledVector(s.up, 0.75);
    desired.copy(P).addScaledVector(s.heading, -dist).addScaledVector(s.up, height);
    lookTarget.copy(carFocus).addScaledVector(s.heading, 2.6 + 0.055 * speed);

    // frame the trajectory: lean toward the predicted landing point while airborne
    const pred = snap.prediction;
    if (v.airborne && pred && pred.valid) {
      const w = 0.16 * smoothstep(0.2, 1.6, pred.timeToImpact);
      tmp.copy(pred.point).sub(lookTarget);
      const len = tmp.length();
      if (len > 1e-3) lookTarget.addScaledVector(tmp, (w * Math.min(len, 60)) / len);
    }

    // ---------------- modes ----------------
    if (s.mode === 'crash') {
      s.crashTime += dt;
      // hold position (slight pull back), keep watching the car
      desired.copy(s.crashAnchor).addScaledVector(WORLD_UP, Math.min(2, s.crashTime * 1.5));
      lookTarget.copy(P);
      s.up.lerp(WORLD_UP, damp(3, dt)).normalize();
    } else if (s.mode === 'complete') {
      s.orbit += dt * 0.22;
      desired.set(P.x + Math.cos(s.orbit) * 10.5, P.y + 3.4, P.z + Math.sin(s.orbit) * 10.5);
      lookTarget.copy(P).addScaledVector(WORLD_UP, 0.5);
      s.up.lerp(WORLD_UP, damp(2, dt)).normalize();
    }

    // ---------------- free look (touch drag) and zoom ----------------
    // The finger swings the boom around the car; a while after it lifts the camera drifts back behind.
    // Pinch / wheel scale the boom and stay where the player left them.
    const look = cameraLook;
    if (look.dragging) look.idle = 0;
    else {
      look.idle += dt;
      if (look.idle > LOOK_HOLD && (look.yaw !== 0 || look.pitch !== 0)) {
        const k = damp(2.4, dt);
        look.yaw -= look.yaw * k;
        look.pitch -= look.pitch * k;
        if (Math.abs(look.yaw) < 1e-3 && Math.abs(look.pitch) < 1e-3) {
          look.yaw = 0;
          look.pitch = 0;
        }
      }
    }
    if (s.mode === 'chase' && (look.yaw !== 0 || look.pitch !== 0 || look.zoom !== 1)) {
      tmp.copy(desired).sub(carFocus).multiplyScalar(look.zoom);
      upQ.setFromAxisAngle(s.up, look.yaw);
      tmp.applyQuaternion(upQ);
      const len = tmp.length();
      if (len > 1e-3) {
        const elev = Math.asin(Math.max(-1, Math.min(1, tmp.dot(s.up) / len)));
        const lift = Math.max(LOOK_MIN_ELEV - elev, Math.min(LOOK_MAX_ELEV - elev, look.pitch));
        // swinging the boom about up × boom lowers the camera, so raise it with the negative angle
        camRight.crossVectors(s.up, tmp).normalize();
        upQ.setFromAxisAngle(camRight, -lift);
        tmp.applyQuaternion(upQ);
        desired.copy(carFocus).add(tmp);
      }
    }

    // ---------------- collision avoidance ----------------
    // Line of sight from the car to the desired boom position. When a level collider blocks it (a
    // slope behind the car, a wall, the crescent), first raise the boom; pull in only as a last resort
    // and never into the car itself.
    const ray = cameraServices.raycast;
    if (ray && s.mode !== 'crash') {
      let need = 0;
      if (!clearLine(ray, carFocus, desired)) {
        need = LIFTS[LIFTS.length - 1];
        for (const lift of LIFTS) {
          candidate.copy(desired).addScaledVector(s.up, lift);
          if (clearLine(ray, carFocus, candidate)) {
            need = lift;
            break;
          }
        }
      }
      // raise fast, settle slowly (no chatter at the threshold)
      s.lift = need > s.lift ? s.lift + (need - s.lift) * damp(14, dt) : Math.max(need, s.lift - dt * 2.2);
      if (s.lift > 1e-3) desired.addScaledVector(s.up, s.lift);

      tmp.copy(desired).sub(carFocus);
      const len = tmp.length();
      if (len > 0.5) {
        tmp.divideScalar(len);
        const hit = ray(carFocus, tmp, len + 0.4);
        const allowed = hit !== null ? hit - 0.45 : Infinity;
        // pull in fast, release slowly
        if (allowed < s.collideDist) s.collideDist = allowed;
        else s.collideDist = Math.min(allowed, s.collideDist + dt * 6);
        if (s.collideDist < len) {
          if (s.collideDist >= MIN_BOOM) desired.copy(carFocus).addScaledVector(tmp, s.collideDist);
          else desired.copy(carFocus).addScaledVector(s.up, MIN_BOOM).addScaledVector(s.heading, -1.2);
        }
      }
    } else {
      s.lift = 0;
    }

    // ---------------- intro fly-in ----------------
    const level = runtime.level;
    if (cameraServices.introPending) {
      cameraServices.introPending = false;
      if (level?.intro) {
        s.mode = 'intro';
        s.introT = 0;
        s.introDur = level.intro.duration;
        s.introFrom.set(...level.intro.from);
        s.introLook.set(...level.intro.lookAt);
      }
    }
    if (s.mode === 'intro') {
      // any throttle input fast-forwards the intro
      s.introT += dt * (Math.abs(v.throttle) > 0.1 || v.speed > 4 ? 3 : 1);
      const k = Math.min(1, s.introT / Math.max(0.1, s.introDur));
      const e = k * k * k * (k * (k * 6 - 15) + 10); // smootherstep
      tmp.copy(s.introFrom).lerp(desired, e);
      tmp2.copy(s.introLook).lerp(lookTarget, e);
      desired.copy(tmp);
      lookTarget.copy(tmp2);
      if (k >= 1) s.mode = 'chase';
      s.initialized = true;
      s.pos.copy(desired);
      s.vel.set(0, 0, 0);
      s.target.copy(lookTarget);
      s.targetVel.set(0, 0, 0);
    }

    // ---------------- smoothing ----------------
    if (!s.initialized) {
      s.pos.copy(desired);
      s.vel.set(0, 0, 0);
      s.target.copy(lookTarget);
      s.targetVel.set(0, 0, 0);
      s.collideDist = Infinity;
      s.lift = 0;
      s.initialized = true;
    } else if (s.mode !== 'intro') {
      const posTime = s.mode === 'crash' ? 0.5 : s.mode === 'complete' ? 0.6 : grounded ? 0.11 : 0.2;
      smoothDampVec3(s.pos, desired, s.vel, posTime, dt);
      smoothDampVec3(s.target, lookTarget, s.targetVel, s.mode === 'chase' ? 0.05 : 0.25, dt);
    }

    // ---------------- FOV ----------------
    s.punch = Math.max(0, s.punch - dt * 1.8);
    const fovTarget =
      s.mode === 'crash'
        ? 52
        : 60 + 13 * sf + 6 * v.boostLevel + 3 * air + 18 * portrait - 7 * Math.sin(Math.min(1, s.punch) * Math.PI);
    s.fov += (fovTarget - s.fov) * damp(3.5, dt);
    if (Math.abs(camera.fov - s.fov) > 0.01) {
      camera.fov = s.fov;
      camera.updateProjectionMatrix();
    }

    // ---------------- shake ----------------
    s.shakeTime += dt;
    const continuous = 0.05 * v.boostLevel + 0.025 * sf * (grounded ? 1 : 0);
    s.trauma = Math.max(0, s.trauma - dt * 1.4);
    const shake = cameraServices.shake ? Math.min(1, s.trauma * s.trauma + continuous) : 0;
    const t = s.shakeTime * 22;
    shakeOffset.set(noise1(t, 1), noise1(t, 2), noise1(t, 3)).multiplyScalar(0.32 * shake);

    // ---------------- apply ----------------
    camera.position.copy(s.pos).add(shakeOffset);
    // controlled roll: a fraction of the car's roll around the view direction
    viewDir.copy(s.target).sub(camera.position).normalize();
    camRight.crossVectors(viewDir, s.up).normalize();
    let roll = 0;
    if (s.mode === 'chase' && camRight.lengthSq() > 0.5) {
      const carRoll = Math.atan2(carUp.dot(camRight), carUp.dot(s.up));
      roll = Math.max(-8 * DEG, Math.min(8 * DEG, carRoll * 0.12));
    }
    roll += noise1(t * 0.7, 4) * 0.6 * DEG * shake;
    rollQ.setFromAxisAngle(viewDir, -roll);
    camera.up.copy(s.up).applyQuaternion(rollQ);
    camera.lookAt(s.target);
  }, CAMERA_PRIORITY);

  return null;
}
