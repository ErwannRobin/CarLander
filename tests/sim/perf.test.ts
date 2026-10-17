import { describe, expect, it } from 'vitest';
import { TEST_RAMP, TEST_VACUUM } from '@/game/levels/testLevels';
import { rampDemoPilot, vacuumDemoPilot } from '@/game/sim/demoPilots';
import type { Autopilot } from '@/game/sim/autopilot';
import type { GameSim } from '@/game/sim/GameSim';
import type { LevelDef } from '@/game/types';
import { createSim } from '../physics/helpers';

async function meanStepMs(level: LevelDef, pilot: Autopilot, seconds: number): Promise<{ ms: number; sim: GameSim }> {
  const sim = await createSim(level);
  // warm-up (JIT) on a throwaway sim
  const warm = await createSim(level);
  for (let i = 0; i < 240; i++) warm.step(pilot.next(warm.snapshot));
  warm.dispose();
  pilot.reset();
  const n = Math.round(seconds * 120);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) sim.step(pilot.next(sim.snapshot, sim.drainEvents()));
  return { ms: (performance.now() - t0) / n, sim };
}

describe('performance', () => {
  it('mean step < 0.6 ms on TEST_RAMP (full run incl. jump + trajectory prediction)', async () => {
    const { ms, sim } = await meanStepMs(TEST_RAMP, rampDemoPilot({ speed: 40 }), 20);
    expect(sim.snapshot.phase).toBe('complete'); // the measured run really contained the jump
    expect(ms).toBeLessThan(0.6);
    sim.dispose();
  });

  it('mean step < 0.6 ms on TEST_VACUUM (vacuum rays + inverted driving)', async () => {
    const { ms, sim } = await meanStepMs(TEST_VACUUM, vacuumDemoPilot(), 20);
    expect(ms).toBeLessThan(0.6);
    sim.dispose();
  });
});
