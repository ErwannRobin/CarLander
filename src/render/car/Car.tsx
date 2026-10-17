/**
 * <Car/> — game binding for the hero car. Reads `runtime.frame` every frame (useFrame priority 0,
 * after the runner and the camera rig) and drives a <CarModel/>:
 *  - root pose      = frame.position / frame.quaternion (interpolated chassis pose)
 *  - wheels         = frame.snapshot.vehicle.wheels (steer, spin, suspension length, spin rate)
 *  - boost / vacuum = vehicle.boostLevel / vehicle.vacuum.strength
 *  - brake lights   = negative throttle while rolling forward
 *  - a subtle, purely visual body motion on the inner body group (lean from lateral
 *    acceleration, squat / dive from longitudinal acceleration), smoothed by a damped spring and
 *    limited to a couple of degrees on top of the physics pose; the wheels stay put.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useRef, useState } from 'react';
import { type ColorRepresentation, Quaternion, Vector3 } from 'three';
import { runtime } from '@/game/runtime';
import type { QualityLevel } from '@/game/types';
import { CarModel, type CarModelHandle } from './CarModel';
import { ContactShadow } from './ContactShadow';

export interface CarProps {
  paint?: ColorRepresentation;
  /** Running lights (default true). */
  lights?: boolean;
  /** Visual body lean / squat (default true). */
  bodyMotion?: boolean;
  shadows?: boolean;
  /** Material quality (default: runtime.quality.level when the car mounts). */
  quality?: QualityLevel;
}

/**
 * Max visual body angles (rad) and gains (rad per m/s²). The physics chassis already rolls and
 * pitches on its springs; this only adds a little life on top, kept small enough that the leaned
 * body never reaches the tyres (CarModel also re-limits wheel travel against the lean).
 */
const MAX_ROLL = 0.035; // ~2.0°
const MAX_PITCH = 0.025; // ~1.4°
const ROLL_GAIN = 0.0022; // ~1.8° at 1 g (14 m/s²) of lateral acceleration
const PITCH_GAIN = 0.0017; // ~1.3° squat at full launch; braking dive reaches the clamp
/** Spring for the body motion: natural frequency (rad/s) and damping ratio. */
const OMEGA = 10;
const ZETA = 0.62;
/** Acceleration estimates are clamped (m/s²): landings and impacts must not kick the body. */
const ACCEL_CLAMP = 24;

export function Car({ paint, lights = true, bodyMotion = true, shadows = true, quality }: CarProps) {
  const model = useRef<CarModelHandle>(null);
  const [materialQuality] = useState<QualityLevel>(() => quality ?? runtime.quality.level);
  // without shadow maps (low preset) a soft contact blob keeps the car grounded
  const [blob] = useState(() => !runtime.quality.shadows);
  const m = useRef({
    qInv: new Quaternion(),
    /** World velocity at the last physics tick seen. */
    prev: new Vector3(),
    hasPrev: false,
    lastTick: 0,
    /** Sim time accumulated since the last new physics tick (s). */
    tickDt: 0,
    /** Chassis-local acceleration estimate (m/s²). */
    acc: new Vector3(),
    roll: 0,
    rollV: 0,
    pitch: 0,
    pitchV: 0,
    ground: 1,
    runId: -1,
    resetPending: false,
  });

  // restarts: forget the motion history so the respawned body does not jolt
  useEffect(
    () =>
      runtime.events.on('reset', () => {
        m.current.resetPending = true;
      }),
    [],
  );

  useFrame(() => {
    const h = model.current;
    if (!h) return;
    const f = runtime.frame;
    const v = f.snapshot.vehicle;
    // a non-finite pose (sim blow-up) would make the whole car vanish: keep the last valid one
    const p = f.position;
    const q = f.quaternion;
    if (Number.isFinite(p.x + p.y + p.z + q.x + q.y + q.z + q.w)) {
      h.group.position.copy(p);
      h.group.quaternion.copy(q);
    }

    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i];
      if (w) h.setWheel(i, w.steerAngle, w.spinAngle, w.suspensionLength, w.spinRate);
    }
    h.setBoost(v.boostLevel);
    h.setVacuum(v.vacuum.strength);
    h.setBrake(v.throttle < 0 && v.forwardSpeed > 0.5 ? Math.min(1, -v.throttle) : 0);
    h.setLights(lights);

    const s = m.current;
    if (!bodyMotion) {
      h.setBodyAttitude(0, 0);
      return;
    }
    if (s.runId !== runtime.runId || s.resetPending) {
      s.runId = runtime.runId;
      s.resetPending = false;
      s.hasPrev = false;
      s.roll = s.rollV = s.pitch = s.pitchV = 0;
      s.acc.set(0, 0, 0);
    }
    const dt = f.simDt;
    if (f.paused || !(dt > 1e-5)) return;

    // Acceleration from the world velocity of successive physics ticks, rotated into the chassis
    // frame. (Differentiating the chassis-local velocity instead would cancel the centripetal
    // term ω × v, so the body would not lean in a steady turn.) Frames without a new tick keep the
    // previous estimate; the elapsed sim time is accumulated so Δv is divided by the time it spans.
    const tick = f.snapshot.tick;
    s.tickDt += dt;
    if (!s.hasPrev || tick < s.lastTick) {
      s.prev.copy(v.velocity);
      s.lastTick = tick;
      s.tickDt = 0;
      s.acc.set(0, 0, 0);
      s.hasPrev = true;
    } else if (tick !== s.lastTick) {
      s.qInv.copy(f.quaternion).invert();
      s.acc.copy(v.velocity).sub(s.prev).divideScalar(Math.max(s.tickDt, 1e-3)).applyQuaternion(s.qInv);
      if (!Number.isFinite(s.acc.x + s.acc.y + s.acc.z)) s.acc.set(0, 0, 0);
      s.acc.clampScalar(-ACCEL_CLAMP, ACCEL_CLAMP);
      s.prev.copy(v.velocity);
      s.lastTick = tick;
      s.tickDt = 0;
    }

    // only lean while the tyres are loaded (no fake lean in free fall or a crash tumble)
    const groundTarget = v.airborne || v.crashed ? 0 : Math.min(1, v.groundedWheels / 3);
    s.ground += (groundTarget - s.ground) * Math.min(1, dt * 8);
    const k = s.ground;
    // lateral accel to the right (+x) leans the body left (+z rotation); forward accel (-z) squats
    const rollTarget = Math.max(-MAX_ROLL, Math.min(MAX_ROLL, s.acc.x * ROLL_GAIN * k));
    const pitchTarget = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, -s.acc.z * PITCH_GAIN * k));

    // damped spring (semi-implicit Euler, sub-stepped for stability at low frame rates)
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h2 = dt / steps;
    for (let n = 0; n < steps; n++) {
      s.rollV += (OMEGA * OMEGA * (rollTarget - s.roll) - 2 * ZETA * OMEGA * s.rollV) * h2;
      s.roll += s.rollV * h2;
      s.pitchV += (OMEGA * OMEGA * (pitchTarget - s.pitch) - 2 * ZETA * OMEGA * s.pitchV) * h2;
      s.pitch += s.pitchV * h2;
    }
    if (!Number.isFinite(s.roll + s.rollV + s.pitch + s.pitchV)) s.roll = s.rollV = s.pitch = s.pitchV = 0;
    s.roll = Math.max(-MAX_ROLL * 1.2, Math.min(MAX_ROLL * 1.2, s.roll));
    s.pitch = Math.max(-MAX_PITCH * 1.2, Math.min(MAX_PITCH * 1.2, s.pitch));
    h.setBodyAttitude(s.pitch, s.roll);
  });

  return (
    <>
      <CarModel ref={model} paint={paint} shadows={shadows} quality={materialQuality} />
      {blob && <ContactShadow />}
    </>
  );
}
