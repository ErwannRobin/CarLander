/**
 * Scripted fake simulation for dev sandbox pages (dev/*.html).
 * Drives `runtime.frame` with a looping 14 s sequence on a flat ground plane at y = 0:
 *
 *   0.0 – 4.0  accelerate along -Z (0 → 45 m/s), wheels spinning
 *   4.0 – 7.0  jump: takeoff, thrusters 4.3–5.6, backflip 4.9–6.2 (RCS pitch), stabilize 6.2–7
 *   7.0        landing (clean) + wheel slam
 *   7.0 – 9.6  drive; vacuum armed 8.0, engaged 8.4–9.4, released 9.4, off 9.6
 *   9.6 – 11.5 drift (tire slip)
 *   11.5       crash impact (sparks), crash event 11.8
 *   12.5       reset (loop)
 *
 * Usage in a dev page (inside <Canvas>):  useMockRuntime();  // or <MockRuntimeDriver />
 */
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import { Quaternion, Vector3 } from 'three';
import { runtime, RUNTIME_FRAME_PRIORITY } from '@/game/runtime';
import { createSnapshot } from '@/game/snapshot';
import type { GameEvent, LandingResult, SimSnapshot } from '@/game/types';
import { VEHICLE } from '@/game/vehicleSpec';

const LOOP = 12.5;
const G = 14;
const RIDE_Y = -VEHICLE.groundY; // chassis origin height above flat ground at rest

function smooth(a: number, b: number, t: number) {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
}

export interface MockOptions {
  /** Time scale of the mock timeline. */
  speed?: number;
  /** Hold the timeline at a fixed time (seconds) — useful for screenshots. */
  freezeAt?: number;
}

export class MockSim {
  snapshot: SimSnapshot = createSnapshot(1);
  private t = 0;
  private prevT = 0;
  private s = 0;
  private lastSpeed = 0;
  private fired = new Set<string>();

  constructor(private opts: MockOptions = {}) {
    this.snapshot.phase = 'running';
    this.snapshot.vehicle.vacuum.available = true;
    this.snapshot.objective = {
      index: 1,
      total: 5,
      id: 'mock',
      title: 'CLEAR THE GAP',
      text: 'Launch from the ramp and land beyond the gap',
      hints: [
        { keys: ['W'], label: 'Accelerate', actions: ['accelerate'] },
        { keys: ['SPACE'], label: 'Thrusters', actions: ['boost'] },
      ],
      complete: false,
    };
  }

  private once(key: string, events: GameEvent[], ev: () => GameEvent) {
    if (this.fired.has(key)) return;
    this.fired.add(key);
    events.push(ev());
  }

  /** Advance the mock; returns events fired during this step. */
  update(dt: number): GameEvent[] {
    const events: GameEvent[] = [];
    if (this.opts.freezeAt !== undefined) {
      this.t = this.opts.freezeAt;
    } else {
      this.t += dt * (this.opts.speed ?? 1);
    }
    if (this.t >= LOOP) {
      this.t -= LOOP;
      this.s = 0;
      this.fired.clear();
      events.push({ type: 'reset' });
    }
    const t = this.t;
    const v = this.snapshot.vehicle;
    const air = this.snapshot.air;

    // speed profile
    let speed = t < 4 ? 11.25 * t : t < 9.6 ? 45 : t < 11.5 ? 45 - (t - 9.6) * 8 : Math.max(0, 30 - (t - 11.5) * 40);
    if (this.opts.freezeAt !== undefined) speed = Math.max(speed, 1);
    this.s += speed * Math.max(0, Math.min(0.1, t - this.prevT >= 0 ? t - this.prevT : dt));
    this.prevT = t;

    // jump arc 4..7 s : vertical speed 21 m/s -> lands after 3 s at G=14
    const inAir = t >= 4 && t < 7;
    const ta = t - 4;
    const y = inAir ? RIDE_Y + 21 * ta - 0.5 * G * ta * ta : RIDE_Y;
    const vy = inAir ? 21 - G * ta : 0;

    // drift: lateral sway + yaw
    const drift = t >= 9.6 && t < 11.5 ? Math.sin((t - 9.6) * 2.2) : 0;
    const x = drift * 3;

    v.position.set(x, y, -this.s);
    v.velocity.set(drift * 6, vy, -speed);
    v.speed = v.velocity.length();
    v.forwardSpeed = speed;

    // orientation: yaw (drift) * pitch (trajectory + backflip)
    const flip = smooth(4.9, 6.2, t) * Math.PI * 2;
    const trajPitch = inAir ? Math.atan2(vy, speed) * 0.5 : 0;
    const yaw = drift * 0.45;
    const q = new Quaternion()
      .setFromAxisAngle(new Vector3(0, 1, 0), yaw)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), trajPitch + flip));
    const crashTumble = t >= 11.5 ? (t - 11.5) * 4 : 0;
    if (crashTumble > 0) q.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), crashTumble));
    v.quaternion.copy(q);
    v.forward.set(0, 0, -1).applyQuaternion(q);
    v.up.set(0, 1, 0).applyQuaternion(q);
    v.right.set(1, 0, 0).applyQuaternion(q);
    v.angularVelocity.set(t > 4.9 && t < 6.2 ? 5 : 0, 0, 0);

    // wheels
    const grounded = !inAir && t < 11.5;
    const bob = Math.sin(t * 9) * 0.03 + (t > 7 && t < 7.4 ? (1 - (t - 7) / 0.4) * 0.6 : 0);
    v.wheels.forEach((w, i) => {
      w.grounded = grounded;
      w.compression = grounded ? Math.min(1, 0.4 + bob) : 0;
      const sp = VEHICLE.suspension;
      w.suspensionLength = grounded ? sp.restLength - w.compression * (sp.restLength - sp.minLength) : sp.restLength;
      w.steerAngle = i < 2 ? -drift * 0.35 : 0;
      w.spinRate = speed / VEHICLE.wheelRadius;
      w.spinAngle += w.spinRate * dt;
      w.slip = t >= 9.6 && t < 11.5 ? 0.6 + 0.4 * Math.abs(drift) : t < 1.2 ? 0.5 : 0;
      const wp = new Vector3(i % 2 === 0 ? -0.86 : 0.86, -RIDE_Y, i < 2 ? -1.36 : 1.36).applyQuaternion(q).add(v.position);
      w.contactPoint.copy(wp);
      w.contactNormal.set(0, 1, 0);
      w.surface = grounded ? 'asphalt' : null;
    });
    v.groundedWheels = grounded ? 4 : 0;
    v.airborne = inAir;
    v.throttle = t < 4 || (t > 7 && t < 9.6) ? 1 : 0;

    // boost 4.3..5.6 (+ short ground boost 2..2.6)
    const boosting = (t >= 4.3 && t < 5.6) || (t >= 2 && t < 2.6);
    v.boostLevel += ((boosting ? 1 : 0) - v.boostLevel) * Math.min(1, dt * 10);
    if (boosting && !v.boosting) events.push({ type: 'boostStart' });
    if (!boosting && v.boosting) events.push({ type: 'boostEnd' });
    v.boosting = boosting;
    v.fuel = Math.max(0, 1 - (t >= 4.3 ? Math.min(1.3, t - 4.3) * 0.5 : 0) - (t >= 2 ? Math.min(0.6, t - 2) * 0.3 : 0));
    v.rcs.pitch = t > 4.9 && t < 6.2 ? 1 : 0; // backflip = nose-up (pitch + = nose up, types.ts)
    v.rcs.roll = t > 6.2 && t < 6.6 ? 0.5 : 0;
    v.rcs.yaw = 0;
    v.stabilizing = t >= 6.2 && t < 7;

    // vacuum
    const vac = v.vacuum;
    const vacHeld = t >= 8 && t < 9.6;
    const engaged = t >= 8.4 && t < 9.4;
    vac.mode = !vacHeld ? 'off' : engaged ? 'engaged' : 'armed';
    vac.strength += ((engaged ? 1 : 0) - vac.strength) * Math.min(1, dt * 8);
    vac.hasSurface = vacHeld;
    vac.distance = vacHeld ? 0.25 : Infinity;
    vac.surfacePoint.set(v.position.x, 0, v.position.z);
    vac.surfaceNormal.set(0, 1, 0);

    // air state + prediction
    air.airborne = inAir;
    air.airTime = inAir ? ta : 0;
    air.height = y - RIDE_Y;
    air.distance = inAir ? ta * 45 : 0;
    air.maxHeight = Math.max(air.maxHeight, air.height);
    air.rotation.pitch = (flip * 180) / Math.PI;
    if (inAir) {
      const tLand = 3 - ta;
      const pt = new Vector3(x, 0, v.position.z - speed * tLand);
      const path: Vector3[] = [];
      for (let i = 0; i <= 24; i++) {
        const tt = (tLand * i) / 24;
        path.push(new Vector3(x, Math.max(0, y + vy * tt - 0.5 * G * tt * tt), v.position.z - speed * tt));
      }
      const align = flip > 0 && flip < Math.PI * 2 ? Math.abs(((flip * 180) / Math.PI + 180) % 360 - 180) : 4;
      this.snapshot.prediction = {
        valid: true,
        point: pt,
        normal: new Vector3(0, 1, 0),
        timeToImpact: tLand,
        alignmentDeg: align,
        pitchErrorDeg: align,
        rollErrorDeg: 0,
        predictedQuality: align < 10 ? 'perfect' : align < 25 ? 'clean' : align < 50 ? 'hard' : 'crash',
        inTarget: true,
        path,
      };
    } else {
      this.snapshot.prediction = null;
    }

    if (t >= 4) this.once('takeoff', events, () => ({ type: 'takeoff', position: v.position.clone(), speed }));
    if (t >= 6.2) {
      const trick = { kind: 'backflip' as const, label: 'BACKFLIP', count: 1, points: 800 };
      this.once('trick', events, () => {
        air.tricks = [trick];
        air.pendingPoints = 1450;
        return { type: 'trick', trick };
      });
    }
    if (t >= 7) {
      this.once('land', events, () => {
        const result: LandingResult = {
          quality: 'clean',
          angleDeg: 6.2,
          impactSpeed: 8.4,
          driftDeg: 3,
          wheelsDown: 4,
          airTime: 3,
          distance: 135,
          maxHeight: 15.7,
          tricks: [{ kind: 'backflip', label: 'BACKFLIP', count: 1, points: 800 }],
          basePoints: 1450,
          multiplier: 1.5,
          points: 2175,
          inTarget: true,
          position: v.position.clone(),
        };
        this.snapshot.score.total += result.points;
        this.snapshot.score.lastLanding = result;
        air.tricks = [];
        air.pendingPoints = 0;
        return { type: 'landing', result };
      });
      this.once('slam', events, () => ({ type: 'wheelSlam', position: v.position.clone().setY(0), strength: 0.7 }));
    }
    if (t >= 8) this.once('vacOn', events, () => ({ type: 'vacuumOn' }));
    if (t >= 8.4)
      this.once('vacEng', events, () => ({ type: 'vacuumEngaged', position: v.position.clone(), normal: new Vector3(0, 1, 0) }));
    if (t >= 9.4) this.once('vacRel', events, () => ({ type: 'vacuumReleased', position: v.position.clone() }));
    if (t >= 9.6) this.once('vacOff', events, () => ({ type: 'vacuumOff' }));
    if (t >= 11.5)
      this.once('impact', events, () => ({
        type: 'impact',
        position: v.position.clone().setY(0.2),
        normal: new Vector3(0, 1, 0),
        strength: 1,
      }));
    if (t >= 11.8) {
      this.once('crash', events, () => {
        this.snapshot.phase = 'crashed';
        this.snapshot.crashReason = 'rollover';
        return { type: 'crash', reason: 'rollover', position: v.position.clone(), impactSpeed: 22 };
      });
    } else if (t < 11.5) {
      this.snapshot.phase = 'running';
      this.snapshot.crashReason = null;
    }
    v.crashed = this.snapshot.phase === 'crashed';

    this.snapshot.time = t;
    this.snapshot.tick++;
    this.snapshot.score.maxSpeed = Math.max(this.snapshot.score.maxSpeed, speed);
    this.lastSpeed = speed;
    return events;
  }
}

/** Hook: drives runtime.frame + runtime.events from a MockSim. Call inside <Canvas>. */
export function useMockRuntime(opts: MockOptions = {}): MockSim {
  const ref = useRef<MockSim | null>(null);
  if (!ref.current) ref.current = new MockSim(opts);
  const sim = ref.current;
  useFrame((state, delta) => {
    const dt = Math.min(0.1, delta);
    const events = sim.update(dt);
    const f = runtime.frame;
    f.snapshot = sim.snapshot;
    f.position.copy(sim.snapshot.vehicle.position);
    f.quaternion.copy(sim.snapshot.vehicle.quaternion);
    f.alpha = 1;
    f.dt = dt;
    f.simDt = dt;
    f.time = state.clock.elapsedTime;
    for (const e of events) runtime.events.emit(e);
  }, RUNTIME_FRAME_PRIORITY);
  return sim;
}

/** Component form of useMockRuntime. */
export function MockRuntimeDriver(props: MockOptions) {
  useMockRuntime(props);
  return null;
}
