import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { TEST_FLAT, TEST_RAMP, TEST_RAMP_PATH } from '@/game/levels/testLevels';
import type { LevelDef } from '@/game/types';
import { VEHICLE } from '@/game/vehicleSpec';
import { createSim, ofType, placeForDrop, run } from './helpers';

const REST_Y = -VEHICLE.groundY;

describe('impacts & tunneling', () => {
  it('a 20 m/s flat-ground landing is HARD: no wild bounce, no tunneling, keeps driving', async () => {
    const sim = await createSim(TEST_FLAT);
    placeForDrop(sim, { impact: 20, horizontal: 20 });
    let touched = -1;
    let minY = Infinity;
    let maxAfter = -Infinity;
    const events = run(sim, 3, undefined, (t) => {
      const v = sim.snapshot.vehicle;
      if (touched < 0 && v.groundedWheels > 0) touched = t;
      minY = Math.min(minY, v.position.y);
      if (touched > 0 && t > touched + 0.25) maxAfter = Math.max(maxAfter, v.position.y);
    });
    const landing = ofType(events, 'landing');
    expect(landing).toHaveLength(1);
    expect(landing[0].result.quality).toBe('hard');
    expect(landing[0].result.impactSpeed).toBeGreaterThan(19);
    expect(landing[0].result.impactSpeed).toBeLessThan(21);
    expect(ofType(events, 'crash')).toHaveLength(0);
    expect(sim.snapshot.phase).toBe('running');
    // bottomed out on the chassis at most (never through the deck), rebound under 15 cm
    expect(minY).toBeGreaterThan(0.18);
    expect(maxAfter - REST_Y).toBeLessThan(0.15);
    expect(sim.snapshot.vehicle.groundedWheels).toBe(4);
    expect(Math.abs(sim.snapshot.vehicle.position.y - REST_Y)).toBeLessThan(0.03);
    expect(ofType(events, 'wheelSlam').length).toBeGreaterThan(0);
    sim.dispose();
  });

  it('PERFECT-range landings (≤ 8 m/s) never bottom the chassis out', async () => {
    const sim = await createSim(TEST_FLAT);
    placeForDrop(sim, { impact: 7.5 });
    let minY = Infinity;
    let touches = 0;
    const events = run(sim, 2, undefined, () => {
      minY = Math.min(minY, sim.snapshot.vehicle.position.y);
      touches += sim.vehicle.touchingCount;
    });
    expect(touches).toBe(0);
    expect(minY - 0.22).toBeGreaterThan(0); // tub bottom stays above the deck
    expect(ofType(events, 'landing')[0].result.quality).toBe('perfect');
    sim.dispose();
  });

  it('80 m/s into a wall does not tunnel (CCD) and is an impact crash', async () => {
    const level: LevelDef = {
      ...TEST_FLAT,
      pieces: [...TEST_FLAT.pieces, { kind: 'box', id: 'wall', center: [0, 5, 1300], size: [40, 10, 1], style: 'metal' }],
    };
    const sim = await createSim(level);
    sim.placeVehicle(new Vector3(0, REST_Y, 1340), new Quaternion(), new Vector3(0, 0, -80));
    let minZ = Infinity;
    const events = run(sim, 2, undefined, () => {
      minZ = Math.min(minZ, sim.snapshot.vehicle.position.z);
    });
    // wall face at z = 1300.5; the nose sits 2.23 m ahead of the origin
    expect(minZ + VEHICLE.noseZ).toBeGreaterThan(1300.5 - 0.15);
    const crash = ofType(events, 'crash');
    expect(crash).toHaveLength(1);
    expect(crash[0].reason).toBe('impact');
    expect(crash[0].impactSpeed).toBeGreaterThan(60);
    expect(sim.snapshot.vehicle.position.z).toBeGreaterThan(1300.5);
    sim.dispose();
  });

  it('an 80 m/s drop onto a ribbon deck does not tunnel', async () => {
    const sim = await createSim(TEST_RAMP);
    const f = TEST_RAMP_PATH.landing[TEST_RAMP_PATH.landing.length - 40];
    sim.placeVehicle(f.position.clone().add(new Vector3(0, 60, 0)), new Quaternion(), new Vector3(0, -80, 0));
    run(sim, 1.5);
    const p = sim.snapshot.vehicle.position;
    expect(p.y).toBeGreaterThan(f.position.y);
    expect(p.y).toBeLessThan(f.position.y + 3);
    sim.dispose();
  });
});
