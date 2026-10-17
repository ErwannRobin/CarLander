import { describe, expect, it } from 'vitest';
import { GameRunner, COUNTDOWN_STEPS } from '@/game/GameRunner';
import { LEVEL_1 } from '@/game/levels/level1';
import { initPhysics } from '@/game/physics/initPhysics';
import { NEUTRAL_INPUT, type InputState } from '@/game/types';

const FRAME = 1 / 60;

async function setup(opts: { enabled?: boolean } = {}) {
  await initPhysics();
  const steps: (number | null)[] = [];
  let sampled = 0;
  const gas: InputState = { ...NEUTRAL_INPUT, throttle: 1 };
  const runner = new GameRunner({
    sampleInput: () => {
      sampled++;
      return gas;
    },
    onCountdown: (s) => steps.push(s),
  });
  runner.countdownEnabled = opts.enabled ?? true;
  runner.load(LEVEL_1);
  const run = (seconds: number) => {
    for (let t = 0; t < seconds - 1e-9; t += FRAME) runner.update(FRAME, t);
  };
  return { runner, steps, run, sampled: () => sampled };
}

describe('start countdown', () => {
  it('holds the car at the line for 3 - 2 - 1, then GO, then the sim runs', async () => {
    const { runner, steps, run, sampled } = await setup();
    expect(steps).toEqual([3]);
    expect(runner.counting).toBe(true);
    run(2.5);
    expect(steps).toEqual([3, 2, 1]);
    expect(runner.sim!.snapshot.time).toBe(0);
    expect(sampled()).toBe(0); // input is not even read while counting
    run(0.6);
    expect(steps).toEqual([3, 2, 1, 0]);
    expect(runner.counting).toBe(false);
    run(0.5);
    expect(runner.sim!.snapshot.time).toBeGreaterThan(0.3);
    expect(sampled()).toBeGreaterThan(0);
    runner.dispose();
    expect(steps[steps.length - 1]).toBeNull();
  });

  it('retries count down faster than the first start', async () => {
    const { runner, steps, run } = await setup();
    run(3.2);
    steps.length = 0;
    runner.restart();
    expect(steps).toEqual([3]);
    run(COUNTDOWN_STEPS * 0.65 + 0.1);
    expect(steps).toEqual([3, 2, 1, 0]);
    runner.dispose();
  });

  it('does not count while paused, and can be switched off', async () => {
    const { runner, steps, run } = await setup();
    runner.paused = true;
    run(5);
    expect(steps).toEqual([3]);
    runner.paused = false;
    run(3.2);
    expect(steps).toEqual([3, 2, 1, 0]);
    runner.dispose();

    const off = await setup({ enabled: false });
    expect(off.steps).toEqual([]);
    expect(off.runner.counting).toBe(false);
    off.run(0.5);
    expect(off.runner.sim!.snapshot.time).toBeGreaterThan(0.3);
    off.runner.dispose();
  });
});
