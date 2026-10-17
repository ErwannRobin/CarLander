import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { TEST_FLAT, TEST_VACUUM, TEST_VACUUM_PATH } from '@/game/levels/testLevels';
import { VacuumSystem } from '@/game/physics/VacuumSystem';
import { Autopilot, followTrack, holdVacuumWhile, runAutopilot, TrackTracker } from '@/game/sim/autopilot';
import { vacuumDemoPilot } from '@/game/sim/demoPilots';
import { frameAt } from '@/game/track/TrackPath';
import { TUNING } from '@/game/tuning';
import type { GameEvent } from '@/game/types';
import { VEHICLE } from '@/game/vehicleSpec';
import { attitude, createSim, D2R, DT, G, input, ofType, run } from './helpers';

describe('vacuum adhesion', () => {
  it('climbs the crescent, holds inverted (≥ 1 s, ≥ 3 wheels) at speed and lets go on release', async () => {
    const sim = await createSim(TEST_VACUUM);
    const pilot = vacuumDemoPilot({ speed: 26 });
    let invertedTime = 0;
    let maxInvertedSpeed = 0;
    let releaseAt = -1;
    let strengthZeroAt = -1;
    let wheelsClearAt = -1;
    let prevHeld = false;
    let t = 0;
    const events: GameEvent[] = [];
    let recent: GameEvent[] = [];
    for (let i = 0; i < 120 * 40 && sim.snapshot.phase !== 'crashed'; i++) {
      const inp = pilot.next(sim.snapshot, recent);
      sim.step(inp);
      t += DT;
      recent = sim.drainEvents();
      events.push(...recent);
      const v = sim.snapshot.vehicle;
      if (v.up.y < -0.9 && v.groundedWheels >= 3) {
        invertedTime += DT;
        maxInvertedSpeed = Math.max(maxInvertedSpeed, v.speed);
      }
      if (prevHeld && !inp.vacuum && releaseAt < 0) releaseAt = t;
      prevHeld = inp.vacuum;
      if (releaseAt > 0 && strengthZeroAt < 0 && v.vacuum.strength < 0.05) strengthZeroAt = t;
      if (releaseAt > 0 && wheelsClearAt < 0 && v.groundedWheels === 0) wheelsClearAt = t;
      if (wheelsClearAt > 0 && t > wheelsClearAt + 0.5) break;
    }
    expect(invertedTime).toBeGreaterThan(1);
    expect(maxInvertedSpeed).toBeGreaterThan(15);
    expect(releaseAt).toBeGreaterThan(0);
    // suction gone within 0.15 s of the release, wheels off the beam shortly after
    expect(strengthZeroAt - releaseAt).toBeLessThan(0.15);
    expect(wheelsClearAt - releaseAt).toBeLessThan(0.3);
    expect(sim.snapshot.phase).toBe('running'); // driving inverted is never a crash
    const types = events.map((e) => e.type).filter((x) => x.startsWith('vacuum'));
    expect(types).toEqual(['vacuumOn', 'vacuumEngaged', 'vacuumOff', 'vacuumReleased']);
    const engaged = ofType(events, 'vacuumEngaged')[0];
    expect(engaged.normal.y).toBeGreaterThan(0.9); // engaged on the runway floor before the pipe
    sim.dispose();
  });

  it('the crescent climb keeps the underbody clear at demo speeds (no belly scrape on the concave curves)', async () => {
    for (const speed of [22, 26]) {
      const sim = await createSim(TEST_VACUUM);
      const P = TEST_VACUUM_PATH;
      const frames = [P.runway, P.crescent];
      const tracker = new TrackTracker(frames);
      const runwayEnd = P.runway[P.runway.length - 1].s;
      const pilot = new Autopilot([
        {
          name: 'climb',
          controllers: [followTrack(frames, speed), holdVacuumWhile((s) => tracker.update(s.vehicle.position).s > runwayEnd - 50)],
          until: (s) => tracker.update(s.vehicle.position).s > runwayEnd + P.invertedStart + 30,
          timeout: 30,
        },
      ]);
      let touchingTicks = 0;
      let minUpY = 1;
      const report = runAutopilot(sim, pilot, {
        maxTime: 30,
        onTick: (s) => {
          touchingTicks += s.vehicle.touchingCount > 0 ? 1 : 0;
          minUpY = Math.min(minUpY, s.snapshot.vehicle.up.y);
        },
      });
      expect(report.stoppedBy).toBe('done');
      expect(minUpY).toBeLessThan(-0.95); // really made it onto the inverted beam
      expect(touchingTicks).toBe(0);
      for (const e of ofType(report.events, 'impact')) expect(e.strength).toBeLessThan(0.2);
      sim.dispose();
    }
  });

  it('is unavailable when the level disables it', async () => {
    const sim = await createSim(TEST_FLAT);
    const events = run(sim, 1, input({ vacuum: true }));
    const vac = sim.snapshot.vehicle.vacuum;
    expect(vac.available).toBe(false);
    expect(vac.mode).toBe('off');
    expect(vac.strength).toBe(0);
    expect(events.filter((e) => e.type.startsWith('vacuum'))).toHaveLength(0);
    sim.dispose();
  });

  it('stays armed (no pull) over non-adhesive surfaces and in open air', async () => {
    const sim = await createSim(TEST_VACUUM);
    const f = TEST_VACUUM_PATH.hill[TEST_VACUUM_PATH.hill.length - 20];
    sim.placeVehicle(f.position.clone().addScaledVector(f.up, -VEHICLE.groundY), f.quaternion.clone());
    run(sim, 0.5, input({ vacuum: true }));
    expect(sim.snapshot.vehicle.vacuum.mode).toBe('armed');
    expect(sim.snapshot.vehicle.vacuum.strength).toBe(0);
    expect(sim.snapshot.vehicle.vacuum.distance).toBe(Infinity);
    sim.dispose();
  });

  it('never changes gravity: an armed vacuum in free fall still accelerates at G', async () => {
    const sim = await createSim(TEST_VACUUM);
    sim.placeVehicle(new Vector3(300, 200, 300), new Quaternion());
    run(sim, 0.2, input({ vacuum: true }));
    const vy0 = sim.snapshot.vehicle.velocity.y;
    run(sim, 1, input({ vacuum: true }));
    const accel = sim.snapshot.vehicle.velocity.y - vy0;
    expect(sim.snapshot.vehicle.vacuum.mode).toBe('armed');
    expect(accel).toBeCloseTo(-G, 0);
    expect(sim.world.gravity.y).toBe(-G);
    sim.dispose();
  });

  it('pulls at the CoM with gravity-aware suction and smooth engage/release ramps', async () => {
    const sim = await createSim(TEST_VACUUM);
    run(sim, 1); // settle on the adhesive runway
    const sag0 = VEHICLE.suspension.restLength - sim.snapshot.vehicle.wheels[0].suspensionLength;
    let fullAt = -1;
    run(sim, 1, input({ vacuum: true }), (t) => {
      if (fullAt < 0 && sim.snapshot.vehicle.vacuum.strength >= 0.999) fullAt = t;
    });
    const vac = sim.snapshot.vehicle.vacuum;
    expect(vac.mode).toBe('engaged');
    expect(fullAt).toBeGreaterThan(0.1); // ≈ 1/8 s ramp, never a snap
    expect(fullAt).toBeLessThan(0.16);
    expect(vac.distance).toBeGreaterThan(0.05);
    expect(vac.distance).toBeLessThan(0.2);
    // on a floor the suction is only `floorG` (slight extra downforce), straight into the surface
    const f = sim.vehicle.vacuum.force;
    expect(f.x).toBeCloseTo(0, 1);
    expect(f.y / (VEHICLE.mass * G)).toBeCloseTo(-TUNING.vacuum.floorG, 2);
    expect(VacuumSystem.suctionG(new Vector3(0, -1, 0))).toBeCloseTo(TUNING.vacuumPeakG, 5);
    expect(VacuumSystem.suctionG(new Vector3(1, 0, 0))).toBeCloseTo(TUNING.vacuum.wallG, 5);
    const sag1 = VEHICLE.suspension.restLength - sim.snapshot.vehicle.wheels[0].suspensionLength;
    expect(sag1 / sag0).toBeGreaterThan(1.3); // ≈ 1.4 g load
    expect(sag1 / sag0).toBeLessThan(1.5);
    let zeroAt = -1;
    run(sim, 0.3, input(), (t) => {
      if (zeroAt < 0 && sim.snapshot.vehicle.vacuum.strength === 0) zeroAt = t;
    });
    expect(zeroAt).toBeGreaterThan(0.05);
    expect(zeroAt).toBeLessThan(0.1);
    sim.dispose();
  });

  it('catches a ceiling from 2.5 m below: alignment assist + suction, then holds inverted', async () => {
    const sim = await createSim(TEST_VACUUM);
    const beam = frameAt(TEST_VACUUM_PATH.crescent, TEST_VACUUM_PATH.invertedStart + 12);
    // hang 2.5 m under the beam, inverted with a 25° roll error, at rest
    const q = beam.quaternion.clone().multiply(attitude(0, 25));
    const pos = beam.position.clone().addScaledVector(beam.up, 2.5);
    sim.placeVehicle(pos, q);
    let minAlign = 180;
    run(sim, 2, input({ vacuum: true }), () => {
      const v = sim.snapshot.vehicle;
      minAlign = Math.min(minAlign, Math.acos(Math.max(-1, Math.min(1, v.up.dot(beam.up)))) / D2R);
    });
    const v = sim.snapshot.vehicle;
    expect(v.vacuum.mode).toBe('engaged');
    expect(v.groundedWheels).toBe(4);
    expect(v.up.y).toBeLessThan(-0.95);
    expect(minAlign).toBeLessThan(5);
    expect(sim.snapshot.phase).toBe('running');
    sim.dispose();
  });
});
