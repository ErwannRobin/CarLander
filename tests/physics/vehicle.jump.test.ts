import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { TEST_FLAT } from '@/game/levels/testLevels';
import { TUNING } from '@/game/tuning';
import type { GameSim } from '@/game/sim/GameSim';
import { attitude, createSim, input, ofType, placeForDrop, run } from './helpers';

async function skySim(q = new Quaternion()): Promise<GameSim> {
  const sim = await createSim(TEST_FLAT);
  sim.placeVehicle(new Vector3(0, 400, 0), q, new Vector3(0, 0, 0));
  return sim;
}

/**
 * Impact speed of the first scored landing of a drop, with the vertical booster fired for the last
 * stretch of the fall or not (held all the way down it would stop the car and lift it again).
 */
async function dropImpact(jump: boolean): Promise<number> {
  const sim = await createSim(TEST_FLAT);
  placeForDrop(sim, { impact: 18, horizontal: 0 });
  const events = run(sim, 2, (_s, t) => input({ jump: jump && t > 0.1 }), (_t, evs) => evs.some((e) => e.type === 'landing'));
  const landing = ofType(events, 'landing')[0];
  sim.dispose();
  expect(landing).toBeDefined();
  return landing.result.impactSpeed;
}

describe('vertical booster (JUMP)', () => {
  it('lifts the car off the deck, burns fuel and reports it without touching the main thrusters', async () => {
    const sim = await createSim(TEST_FLAT);
    const events = run(sim, 0.8, input({ jump: true }));
    const v = sim.snapshot.vehicle;
    expect(v.airborne).toBe(true);
    expect(v.position.y).toBeGreaterThan(1.5);
    expect(v.velocity.y).toBeGreaterThan(5);
    expect(v.jumping).toBe(true);
    expect(v.jumpLevel).toBeGreaterThan(0.9);
    expect(v.boosting).toBe(false);
    expect(v.boostLevel).toBe(0);
    expect(v.fuel).toBeLessThan(1);
    expect(ofType(events, 'jumpStart')).toHaveLength(1);
    expect(ofType(events, 'boostStart')).toHaveLength(0);
    sim.dispose();
  });

  it('pushes along the chassis up axis: a car pitched nose-up is shoved backwards', async () => {
    const sim = await skySim(attitude(60, 0));
    run(sim, 0.6, input({ jump: true }));
    const v = sim.snapshot.vehicle;
    expect(v.velocity.z).toBeGreaterThan(3); // chassis up leans toward +Z (backwards)
    sim.dispose();
  });

  it('cushions a landing: the same fall touches down several m/s slower', async () => {
    const free = await dropImpact(false);
    const cushioned = await dropImpact(true);
    expect(free).toBeGreaterThan(15);
    expect(cushioned).toBeLessThan(free - 4);
  });

  it('cannot accelerate without limit: the climb speed settles under maxClimb', async () => {
    const sim = await skySim();
    run(sim, 3.5, input({ jump: true }));
    const vUp = sim.snapshot.vehicle.velocity.y;
    expect(vUp).toBeGreaterThan(15);
    expect(vUp).toBeLessThan(TUNING.jump.maxClimb + 0.5);
    sim.dispose();
  });

  it('shares the tank with the thrusters: an empty tank cuts it once and stays cut until released', async () => {
    const sim = await skySim();
    sim.vehicle.setFuel(0.04); // 0.24 s of burn
    const burn = run(sim, 0.5, input({ jump: true }));
    expect(ofType(burn, 'fuelEmpty')).toHaveLength(1);
    expect(ofType(burn, 'jumpEnd')).toHaveLength(1);
    expect(sim.snapshot.vehicle.fuel).toBe(0);
    expect(sim.snapshot.vehicle.jumping).toBe(false);
    const held = run(sim, 0.3, input({ jump: true }));
    expect(ofType(held, 'jumpStart')).toHaveLength(0);
    // the main thrusters cannot start either: same tank
    const boost = run(sim, 0.3, input({ boost: true }));
    expect(ofType(boost, 'boostStart')).toHaveLength(0);
    sim.dispose();
  });

  it('does nothing when not pressed', async () => {
    const idle = await skySim();
    run(idle, 1, input());
    expect(idle.snapshot.vehicle.jumpLevel).toBe(0);
    expect(idle.snapshot.vehicle.fuel).toBe(1);
    idle.dispose();
  });
});
