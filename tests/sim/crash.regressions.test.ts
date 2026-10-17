/**
 * Crash-detector regressions found in QA:
 *  - an upright car scraping a wall on its wheels was flagged as a `rollover` after 0.25 s
 *    (the wall normal is ~90° from chassis up) — rollover now requires the car not to stand on its wheels;
 *  - roof crashes reported `impactSpeed ≈ 0` because the speculative contact had already stopped the
 *    body one tick before the real touch — the detector now reports the recent peak approach speed;
 *  - no `impact` events were emitted after a crash (the detector only ran while 'running');
 *  - scrape strength only followed the sliding speed, so a light graze at speed read as a heavy scrape.
 */
import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { TEST_FLAT, TEST_VACUUM, TEST_VACUUM_PATH } from '@/game/levels/testLevels';
import { Autopilot, followTrack, holdVacuumWhile, runAutopilot, TrackTracker } from '@/game/sim/autopilot';
import type { LevelDef } from '@/game/types';
import { CHASSIS_COLLIDERS, VEHICLE } from '@/game/vehicleSpec';
import { attitude, createSim, G, input, ofType, run } from '../physics/helpers';

const REST_Y = -VEHICLE.groundY;

describe('crash detection regressions', () => {
  it('scraping along a wall upright on four wheels is not a crash (impact events only)', async () => {
    const level: LevelDef = {
      ...TEST_FLAT,
      pieces: [...TEST_FLAT.pieces, { kind: 'box', id: 'wall', center: [3, 1, 1000], size: [1, 2, 800], style: 'metal' }],
    };
    for (const speed of [8, 20, 35]) {
      const sim = await createSim(level);
      // wall face at x = 2.5; car side at x ≈ 0.99 from its center: start 0.1 m off the wall, steer into it
      sim.placeVehicle(new Vector3(1.4, REST_Y, 1350), new Quaternion(), new Vector3(0, 0, -speed));
      let contactTicks = 0;
      let minWheels = 4;
      const events = run(sim, 3, (s) => input({ throttle: (speed - s.snapshot.vehicle.forwardSpeed) * 0.3, steer: 0.12 }), () => {
        if (sim.vehicle.touchingCount > 0) contactTicks++;
        minWheels = Math.min(minWheels, sim.snapshot.vehicle.groundedWheels);
      });
      expect(contactTicks / 120).toBeGreaterThan(0.5); // really grinding along the wall
      expect(ofType(events, 'impact').length).toBeGreaterThan(0); // sparks / scrape audio
      expect(ofType(events, 'crash')).toHaveLength(0);
      expect(sim.snapshot.phase).toBe('running');
      expect(minWheels).toBeGreaterThanOrEqual(3);
      expect(sim.snapshot.vehicle.up.y).toBeGreaterThan(0.95);
      sim.dispose();
    }
  });

  it('a car lying on its side against a wall is still a rollover', async () => {
    const level: LevelDef = {
      ...TEST_FLAT,
      pieces: [...TEST_FLAT.pieces, { kind: 'box', id: 'wall', center: [3, 1, 1000], size: [1, 2, 800], style: 'metal' }],
    };
    const sim = await createSim(level);
    // on its left side (rolled −90°: roof toward −X), next to the wall
    sim.placeVehicle(new Vector3(1.4, 1.05, 1000), attitude(0, -90));
    const events = run(sim, 1.5);
    expect(ofType(events, 'crash')[0]?.reason).toBe('rollover');
    sim.dispose();
  });

  it('lying on its side with the wheels against a wall (rays touching, no load) is still a rollover', async () => {
    const level: LevelDef = {
      ...TEST_FLAT,
      pieces: [...TEST_FLAT.pieces, { kind: 'box', id: 'wall', center: [3, 2, 1000], size: [1, 4, 800], style: 'metal' }],
    };
    const sim = await createSim(level);
    // rolled −90°: chassis up = −X, underside (and the wheel rays) facing the wall face at x = 2.5
    sim.placeVehicle(new Vector3(2.2, 1.0, 1000), attitude(0, -90));
    let wheelsOnWall = 0;
    const events = run(sim, 2, undefined, () => {
      wheelsOnWall = Math.max(wheelsOnWall, sim.snapshot.vehicle.groundedWheels);
    });
    expect(wheelsOnWall).toBeGreaterThanOrEqual(2); // the scenario really has wheel rays on the wall
    expect(ofType(events, 'crash')[0]?.reason).toBe('rollover');
    sim.dispose();
  });

  it('the wreck keeps emitting impact events after the crash (tumble sparks / scrape audio)', async () => {
    const sim = await createSim(TEST_FLAT);
    const cabin = CHASSIS_COLLIDERS[1];
    sim.placeVehicle(new Vector3(0, cabin.center[1] + cabin.halfExtents[1] + cabin.borderRadius + 0.01, 1000), attitude(0, 180), new Vector3(0, 0, -20));
    const events = run(sim, 1.2);
    const crash = ofType(events, 'crash');
    expect(crash).toHaveLength(1);
    const crashIndex = events.indexOf(crash[0]);
    const after = events.slice(crashIndex + 1).filter((e) => e.type === 'impact');
    expect(after.length).toBeGreaterThan(4); // scraping along on the roof
    expect(Math.max(...after.map((e) => (e.type === 'impact' ? e.strength : 0)))).toBeGreaterThan(0.3);
    sim.dispose();
  });

  it('scrape strength follows the contact load: grazing a concave ramp at excessive speed stays mostly faint', async () => {
    const sim = await createSim(TEST_VACUUM);
    const P = TEST_VACUUM_PATH;
    const frames = [P.runway, P.crescent];
    const tracker = new TrackTracker(frames);
    const runwayEnd = P.runway[P.runway.length - 1].s;
    const pilot = new Autopilot([
      {
        name: 'too-fast',
        controllers: [followTrack(frames, 40), holdVacuumWhile((s) => tracker.update(s.vehicle.position).s > runwayEnd - 50)],
        until: (s) => tracker.update(s.vehicle.position).s > runwayEnd + P.invertedStart + 30,
        timeout: 30,
      },
    ]);
    const report = runAutopilot(sim, pilot, { maxTime: 30 });
    const strengths = ofType(report.events, 'impact')
      .map((e) => e.strength)
      .sort((a, b) => a - b);
    expect(strengths.length).toBeGreaterThan(5); // 40 m/s does graze the nose and tail
    expect(strengths[Math.floor(strengths.length / 2)]).toBeLessThan(0.25);
    sim.dispose();
  });

  it('roof crashes report the real impact speed (measured on the speculative contact)', async () => {
    for (const impact of [1, 3, 6]) {
      const sim = await createSim(TEST_FLAT);
      const h = (impact * impact) / (2 * G);
      // exactly upside down; the cabin collider top (local y 0.72) touches the deck when the origin is 0.72 m up
      const cabin = CHASSIS_COLLIDERS[1];
      const roofTop = cabin.center[1] + cabin.halfExtents[1] + cabin.borderRadius;
      sim.placeVehicle(new Vector3(0, roofTop + 0.003 + h, 0), attitude(0, 180));
      sim.drainEvents();
      const crash = ofType(run(sim, 1.5), 'crash');
      expect(crash).toHaveLength(1);
      expect(crash[0].reason).toBe('roof');
      expect(Math.abs(crash[0].impactSpeed - impact)).toBeLessThan(0.25 + impact * 0.1);
      sim.dispose();
    }
  });
});
