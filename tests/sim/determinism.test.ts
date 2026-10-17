import { describe, expect, it } from 'vitest';
import { TEST_RAMP } from '@/game/levels/testLevels';
import type { GameSim } from '@/game/sim/GameSim';
import type { InputState } from '@/game/types';
import { createSim, input, run } from '../physics/helpers';

/** A 20 s script mixing every control: accelerate, steer, boost, jump, air tricks, stabilize. */
function script(_sim: GameSim, t: number): InputState {
  if (t < 3) return input({ throttle: 1 });
  if (t < 4) return input({ throttle: 1, steer: 0.3 });
  if (t < 5) return input({ throttle: 1, steer: -0.3 });
  if (t < 9) return input({ throttle: 1, boost: t > 7.5 });
  if (t < 9.6) return input({ throttle: -1, roll: 0.5 });
  if (t < 12) return input({ stabilize: true });
  if (t < 15) return input({ throttle: 0.6, steer: Math.sin(t * 2) });
  return input({ throttle: -0.4 });
}

function fingerprint(sim: GameSim): number[] {
  const v = sim.snapshot.vehicle;
  return [
    ...v.position.toArray(),
    ...v.quaternion.toArray(),
    ...v.velocity.toArray(),
    ...v.angularVelocity.toArray(),
    v.fuel,
    sim.snapshot.score.total,
    ...v.wheels.map((w) => w.suspensionLength),
  ];
}

describe('determinism', () => {
  it('the same 20 s input script twice gives identical poses (< 1e-9)', async () => {
    const a = await createSim(TEST_RAMP);
    const b = await createSim(TEST_RAMP);
    const evA = run(a, 20, script);
    const evB = run(b, 20, script);
    const fa = fingerprint(a);
    const fb = fingerprint(b);
    for (let i = 0; i < fa.length; i++) expect(Math.abs(fa[i] - fb[i])).toBeLessThan(1e-9);
    expect(evA.map((e) => e.type)).toEqual(evB.map((e) => e.type));
    expect(a.snapshot.tick).toBe(2400);
    a.dispose();
    b.dispose();
  });

  it('reset() restores the spawn exactly, emits reset, and replays identically', async () => {
    const fresh = await createSim(TEST_RAMP);
    const spawn = fingerprint(fresh);
    const spawnPose = { p: fresh.currPose.position.clone(), q: fresh.currPose.quaternion.clone() };
    run(fresh, 8, script);
    fresh.reset();
    const events = fresh.drainEvents();
    expect(events[0]).toEqual({ type: 'reset' });
    expect(events.some((e) => e.type === 'objective')).toBe(true);
    expect(fingerprint(fresh)).toEqual(spawn);
    expect(fresh.snapshot.tick).toBe(0);
    expect(fresh.snapshot.time).toBe(0);
    expect(fresh.snapshot.phase).toBe('ready');
    expect(fresh.snapshot.score.total).toBe(0);
    expect(fresh.prevPose.position.equals(spawnPose.p)).toBe(true);
    expect(fresh.currPose.quaternion.equals(spawnPose.q)).toBe(true);

    const other = await createSim(TEST_RAMP);
    run(fresh, 10, script);
    run(other, 10, script);
    expect(fingerprint(fresh)).toEqual(fingerprint(other));
    fresh.dispose();
    other.dispose();
  });

  it('prevPose / currPose bracket each tick for interpolation', async () => {
    const sim = await createSim(TEST_RAMP);
    run(sim, 1, input({ throttle: 1 }));
    const before = sim.currPose.position.clone();
    sim.step(input({ throttle: 1 }));
    expect(sim.prevPose.position.equals(before)).toBe(true);
    expect(sim.currPose.position.equals(sim.snapshot.vehicle.position)).toBe(true);
    expect(sim.currPose.position.distanceTo(before)).toBeGreaterThan(0.05);
    sim.dispose();
  });
});
