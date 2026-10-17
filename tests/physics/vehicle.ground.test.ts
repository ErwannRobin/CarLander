import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { TEST_FLAT, TEST_RAMP, TEST_RAMP_PATH } from '@/game/levels/testLevels';
import { TUNING } from '@/game/tuning';
import { VEHICLE } from '@/game/vehicleSpec';
import { createSim, input, KMH, ofType, R2D, run } from './helpers';

describe('vehicle on the ground', () => {
  it('settles at rest: |v| < 0.05 m/s after 3 s, sag 0.10–0.14 m, no jitter', async () => {
    const sim = await createSim(TEST_FLAT);
    const ys: number[] = [];
    const events = run(sim, 3, input(), () => {
      ys.push(sim.snapshot.vehicle.position.y);
    });
    const v = sim.snapshot.vehicle;
    expect(v.speed).toBeLessThan(0.05);
    expect(v.angularVelocity.length()).toBeLessThan(0.01);
    expect(v.groundedWheels).toBe(4);
    expect(v.airborne).toBe(false);
    for (const w of v.wheels) {
      const sag = VEHICLE.suspension.restLength - w.suspensionLength;
      expect(sag).toBeGreaterThan(0.1);
      expect(sag).toBeLessThan(0.14);
      expect(w.slip).toBe(0);
    }
    // ride height matches the spec (origin at axle height: ground + 0.36)
    expect(Math.abs(v.position.y - -VEHICLE.groundY)).toBeLessThan(0.02);
    // last second: sub-millimeter vertical motion
    const last = ys.slice(-120);
    expect(Math.max(...last) - Math.min(...last)).toBeLessThan(1e-3);
    expect(ofType(events, 'takeoff')).toHaveLength(0);
    sim.dispose();
  });

  it('holds still on an 11° slope with no input', async () => {
    const sim = await createSim(TEST_RAMP);
    const f = TEST_RAMP_PATH.kicker[14];
    const start = f.position.clone().addScaledVector(f.up, -VEHICLE.groundY);
    sim.placeVehicle(start, f.quaternion.clone());
    run(sim, 3);
    expect(sim.snapshot.vehicle.speed).toBeLessThan(0.05);
    expect(sim.snapshot.vehicle.position.distanceTo(start)).toBeLessThan(0.05);
    sim.dispose();
  });

  it('accelerates 0–100 km/h in ≈ 2.3 s and tops out near 205 km/h', async () => {
    const sim = await createSim(TEST_FLAT);
    let t100 = -1;
    run(sim, 25, input({ throttle: 1 }), (t) => {
      if (t100 < 0 && sim.snapshot.vehicle.speed >= 100 / KMH) t100 = t;
    });
    expect(t100).toBeGreaterThan(2.0);
    expect(t100).toBeLessThan(2.6);
    const top = sim.snapshot.vehicle.speed * KMH;
    expect(top).toBeGreaterThan(198);
    expect(top).toBeLessThan(212);
    // straight line stays straight
    expect(Math.abs(sim.snapshot.vehicle.position.x)).toBeLessThan(0.5);
    sim.dispose();
  });

  it('thrust pushes the car to ≈ 290 km/h', async () => {
    const sim = await createSim(TEST_FLAT);
    run(sim, 10, input({ throttle: 1 }));
    run(sim, 12, (s) => {
      s.vehicle.setFuel(1); // unlimited fuel for the top-speed measurement
      return input({ throttle: 1, boost: true });
    });
    const top = sim.snapshot.vehicle.speed * KMH;
    expect(top).toBeGreaterThan(280);
    expect(top).toBeLessThan(TUNING.maxSpeedBoost * KMH + 2);
    expect(sim.snapshot.vehicle.boosting).toBe(true);
    expect(sim.snapshot.vehicle.boostLevel).toBeGreaterThan(0.95);
    sim.dispose();
  });

  it('brakes to a stop, then reverses up to the reverse limit', async () => {
    const sim = await createSim(TEST_FLAT);
    run(sim, 4, input({ throttle: 1 }));
    expect(sim.snapshot.vehicle.forwardSpeed).toBeGreaterThan(35);
    let stop = -1;
    run(sim, 8, input({ throttle: -1 }), (t) => {
      if (stop < 0 && sim.snapshot.vehicle.forwardSpeed < 0.5) stop = t;
    });
    expect(stop).toBeGreaterThan(1.2);
    expect(stop).toBeLessThan(2.5);
    expect(sim.snapshot.vehicle.forwardSpeed).toBeLessThan(-TUNING.reverseMaxSpeed + 1.5);
    expect(sim.snapshot.vehicle.forwardSpeed).toBeGreaterThan(-TUNING.reverseMaxSpeed - 0.5);
    sim.dispose();
  });

  it('full lock at 60 km/h turns a 10–15 m radius without spinning', async () => {
    const sim = await createSim(TEST_FLAT);
    const target = 60 / KMH;
    const hold = (steer: number) => (s: typeof sim) =>
      input({ throttle: Math.max(-1, Math.min(1, (target - s.snapshot.vehicle.forwardSpeed) * 0.8)), steer });
    run(sim, 6, hold(0));
    const pts: Vector3[] = [];
    let maxSlip = 0;
    run(sim, 8, hold(-1), (t) => {
      const v = sim.snapshot.vehicle;
      if (t > 2) {
        pts.push(v.position.clone());
        const beta = Math.atan2(v.velocity.dot(v.right), v.velocity.dot(v.forward)) * R2D;
        maxSlip = Math.max(maxSlip, Math.abs(beta));
      }
    });
    const c = pts.reduce((a, p) => a.add(p), new Vector3()).divideScalar(pts.length);
    const radius = pts.reduce((a, p) => a + Math.hypot(p.x - c.x, p.z - c.z), 0) / pts.length;
    expect(radius).toBeGreaterThan(10);
    expect(radius).toBeLessThan(15);
    // no spin: body slip stays small, car upright, speed held
    expect(maxSlip).toBeLessThan(15);
    expect(sim.snapshot.vehicle.up.y).toBeGreaterThan(0.97);
    expect(Math.abs(sim.snapshot.vehicle.speed * KMH - 60)).toBeLessThan(6);
    // left turn: positive steer angle and counter-clockwise yaw (seen from above)
    expect(sim.snapshot.vehicle.wheels[0].steerAngle).toBeGreaterThan(0);
    expect(sim.snapshot.vehicle.angularVelocity.y).toBeGreaterThan(0);
    sim.dispose();
  });

  it('a 200 km/h lane change stays planted', async () => {
    const sim = await createSim(TEST_FLAT);
    run(sim, 20, (s) => input({ throttle: s.snapshot.vehicle.speed < 200 / KMH ? 1 : 0 }));
    expect(sim.snapshot.vehicle.speed * KMH).toBeGreaterThan(195);
    let maxRoll = 0;
    let minUp = 1;
    let minWheels = 4;
    const seq: [number, number][] = [
      [-1, 0.5],
      [1, 0.8],
      [-1, 0.5],
      [0, 2],
    ];
    for (const [steer, dur] of seq) {
      run(sim, dur, input({ throttle: 1, steer }), () => {
        const v = sim.snapshot.vehicle;
        maxRoll = Math.max(maxRoll, Math.abs(Math.asin(v.right.y)) * R2D);
        minUp = Math.min(minUp, v.up.y);
        minWheels = Math.min(minWheels, v.groundedWheels);
      });
    }
    expect(maxRoll).toBeLessThan(8);
    expect(minUp).toBeGreaterThan(0.98);
    expect(minWheels).toBeGreaterThanOrEqual(3);
    expect(sim.snapshot.phase).toBe('running');
    sim.dispose();
  });

  it('reports wheel visuals: spin follows speed, front wheels steer, rears do not', async () => {
    const sim = await createSim(TEST_FLAT);
    run(sim, 2, input({ throttle: 0.6 }));
    run(sim, 1, input({ throttle: 0.2, steer: 0.25 }));
    const v = sim.snapshot.vehicle;
    const expectedRate = v.forwardSpeed / VEHICLE.wheelRadius;
    for (const w of v.wheels) {
      expect(w.grounded).toBe(true);
      expect(Math.abs(w.spinRate - expectedRate) / expectedRate).toBeLessThan(0.08);
      expect(w.slip).toBeLessThan(0.3);
      expect(w.surface).toBe('concrete');
      expect(w.contactNormal.y).toBeGreaterThan(0.99);
      expect(Math.abs(w.contactPoint.y)).toBeLessThan(0.05);
    }
    expect(v.wheels[0].steerAngle).toBeLessThan(0); // steering right ⇒ negative (right) angle
    expect(v.wheels[1].steerAngle).toBeLessThan(0);
    expect(v.wheels[2].steerAngle).toBe(0);
    expect(v.wheels[3].steerAngle).toBe(0);
    sim.dispose();
  });
});
