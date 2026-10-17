import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { TEST_FLAT } from '@/game/levels/testLevels';
import type { GameSim } from '@/game/sim/GameSim';
import type { InputState } from '@/game/types';
import { attitude, createSim, input, ofType, run, tiltDeg } from './helpers';

/** Places the car high above the deck, level, cruising forward. */
async function skySim(opts: { flightAssist?: boolean; q?: Quaternion; v?: Vector3 } = {}): Promise<GameSim> {
  const sim = await createSim(TEST_FLAT, { flightAssist: opts.flightAssist ?? false });
  sim.placeVehicle(new Vector3(0, 400, 0), opts.q ?? new Quaternion(), opts.v ?? new Vector3(0, 0, -30));
  return sim;
}

/** Seconds from the first airborne tick until |rotation| on `axis` reaches 360°. */
function timeTo360(sim: GameSim, held: Partial<InputState>, axis: 'pitch' | 'yaw' | 'roll'): number {
  let airborneAt = -1;
  let done = -1;
  run(sim, 4, input(held), (t) => {
    if (airborneAt < 0 && sim.snapshot.vehicle.airborne) airborneAt = t - 1 / 120;
    if (done < 0 && Math.abs(sim.snapshot.air.rotation[axis]) >= 360) done = t;
    return done > 0;
  });
  return done - airborneAt;
}

describe('air control', () => {
  it('W held: a 360° frontflip takes ≈ 1.2–1.4 s; releasing stops the rotation in ≈ 0.5 s', async () => {
    const sim = await skySim();
    const t = timeTo360(sim, { throttle: 1 }, 'pitch');
    expect(t).toBeGreaterThan(1.15);
    expect(t).toBeLessThan(1.45);
    expect(sim.snapshot.air.rotation.pitch).toBeLessThan(0); // nose down = frontflip
    let stop = -1;
    run(sim, 2, input(), (tt) => {
      if (stop < 0 && sim.snapshot.vehicle.angularVelocity.length() < 0.1) stop = tt;
    });
    expect(stop).toBeGreaterThan(0.2);
    expect(stop).toBeLessThan(0.6);
    expect(sim.snapshot.vehicle.angularVelocity.length()).toBeLessThan(1e-3);
    sim.dispose();
  });

  it('maps S / A / E to backflip, left spin and right barrel roll with RCS activity', async () => {
    const back = await skySim();
    expect(timeTo360(back, { throttle: -1 }, 'pitch')).toBeLessThan(1.45);
    expect(back.snapshot.air.rotation.pitch).toBeGreaterThan(0);
    expect(back.snapshot.vehicle.rcs.pitch).toBeGreaterThan(0);
    back.dispose();

    const spin = await skySim();
    expect(timeTo360(spin, { steer: -1 }, 'yaw')).toBeLessThan(2.2);
    expect(spin.snapshot.air.rotation.yaw).toBeGreaterThan(0); // + = left
    spin.dispose();

    const roll = await skySim();
    expect(timeTo360(roll, { roll: 1 }, 'roll')).toBeLessThan(1.4);
    expect(roll.snapshot.air.rotation.roll).toBeGreaterThan(0); // + = roll right
    roll.dispose();
  });

  it('stabilizer levels a 70° roll in ≈ 1.2 s without snapping or overshoot', async () => {
    const sim = await skySim({ q: attitude(0, 70) });
    let within2 = -1;
    let maxRate = 0;
    let overshoot = 0;
    run(sim, 3, input({ stabilize: true }), (t) => {
      const v = sim.snapshot.vehicle;
      maxRate = Math.max(maxRate, v.angularVelocity.length());
      if (within2 < 0 && tiltDeg(sim) < 2) within2 = t;
      if (within2 > 0) overshoot = Math.max(overshoot, tiltDeg(sim));
    });
    expect(within2).toBeGreaterThan(0.8);
    expect(within2).toBeLessThan(1.5);
    expect(maxRate).toBeLessThanOrEqual(4.05); // never faster than the 4 rad/s cap
    expect(overshoot).toBeLessThan(3);
    expect(sim.snapshot.vehicle.stabilizing).toBe(true);
    sim.dispose();
  });

  it('flight assist slowly levels the car when no rotation input is held (weaker than Shift)', async () => {
    const assisted = await skySim({ flightAssist: true, q: attitude(0, 40) });
    run(assisted, 1.2);
    const after12 = tiltDeg(assisted);
    run(assisted, 4);
    expect(after12).toBeGreaterThan(10); // weak: nowhere near level after 1.2 s
    expect(tiltDeg(assisted)).toBeLessThan(6);
    assisted.dispose();

    const free = await skySim({ flightAssist: false, q: attitude(0, 40) });
    run(free, 3);
    expect(Math.abs(tiltDeg(free) - 40)).toBeLessThan(0.5);
    free.dispose();
  });

  it('thrust pitched up gains altitude (thrust > gravity) and burns fuel', async () => {
    const sim = await skySim({ q: attitude(60, 0), v: new Vector3(0, 0, 0) });
    const y0 = sim.snapshot.vehicle.position.y;
    const events = run(sim, 1.5, input({ boost: true, stabilize: false }));
    const v = sim.snapshot.vehicle;
    expect(v.position.y - y0).toBeGreaterThan(5);
    expect(v.velocity.y).toBeGreaterThan(5);
    expect(v.fuel).toBeLessThan(1);
    expect(v.boostLevel).toBeGreaterThan(0.9);
    expect(ofType(events, 'boostStart')).toHaveLength(1);
    sim.dispose();
  });

  it('fuel empties (fuelEmpty + boostEnd) and regenerates on the ground after the delay', async () => {
    const sim = await createSim(TEST_FLAT); // capacity 6 s, regen 0.6 s/s after 1 s
    const events = run(sim, 6.5, input({ boost: true }));
    expect(ofType(events, 'fuelEmpty')).toHaveLength(1);
    expect(ofType(events, 'boostEnd')).toHaveLength(1);
    expect(sim.snapshot.vehicle.fuel).toBe(0);
    expect(sim.snapshot.vehicle.boosting).toBe(false);
    // the tank emptied at 6.0 s; still holding boost with an empty tank: no flicker, no regen yet
    const held = run(sim, 0.4, input({ boost: true }));
    expect(ofType(held, 'boostStart')).toHaveLength(0);
    expect(sim.snapshot.vehicle.fuel).toBe(0); // regen delay: 1 s after the burn ended
    run(sim, 2, input());
    expect(sim.snapshot.vehicle.fuel).toBeGreaterThan(0.15);
    sim.dispose();
  });
});
