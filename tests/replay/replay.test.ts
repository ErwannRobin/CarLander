import { describe, expect, it } from 'vitest';
import { GameRunner, type ReplayStatus } from '@/game/GameRunner';
import { initPhysics } from '@/game/physics/initPhysics';
import { TEST_RAMP } from '@/game/levels/testLevels';
import { CLIP_SECONDS, InputLog, planClip, slowMotionAt } from '@/game/replay';
import { rampDemoPilot } from '@/game/sim/demoPilots';
import type { GameSim } from '@/game/sim/GameSim';
import { TUNING } from '@/game/tuning';
import { NEUTRAL_INPUT, type GameEvent } from '@/game/types';

const fingerprint = (sim: GameSim) => {
  const v = sim.snapshot.vehicle;
  return [...v.position.toArray(), ...v.quaternion.toArray(), ...v.velocity.toArray(), v.fuel, sim.snapshot.score.total];
};

describe('InputLog', () => {
  it('round-trips every field exactly, including unquantised analog values', () => {
    const log = new InputLog();
    const a = { throttle: 0.123456789012, steer: -0.987654321, roll: 1 / 3, boost: true, jump: false, vacuum: true, stabilize: false };
    for (let i = 0; i < 3000; i++) log.push(i % 2 ? a : NEUTRAL_INPUT, i % 3 === 0);
    expect(log.length).toBe(3000);
    const out = { ...NEUTRAL_INPUT };
    expect(log.read(1, out)).toBe(false);
    expect(out).toEqual(a);
    expect(log.read(2998, out)).toBe(false);
    expect(log.read(2997, out)).toBe(true);
    expect(out).toEqual(a);
    log.read(2998, out);
    expect(out).toEqual(NEUTRAL_INPUT);
  });
});

describe('clip planning and slow motion', () => {
  const dt = TUNING.dt;
  it('ends a short tail after the finish and lasts CLIP_SECONDS', () => {
    const clip = planClip(10000, 6000, [{ tick: 6000, floor: 0.4 }, { tick: 100, floor: 0.3 }]);
    expect(clip.end).toBe(6000 + Math.round(2 / dt));
    expect(clip.end - clip.start).toBe(Math.round(CLIP_SECONDS / dt));
    expect(clip.moments).toEqual([{ tick: 6000, floor: 0.4 }]); // the early one is outside the clip
  });
  it('starts at 0 for runs shorter than the clip, and stops at the log end', () => {
    const clip = planClip(500, 400, []);
    expect(clip.start).toBe(0);
    expect(clip.end).toBe(500);
  });
  it('slow motion dips to the floor at a moment and is 1 well away from it', () => {
    const m = [{ tick: 1000, floor: 0.3 }];
    expect(slowMotionAt(0, m)).toBe(1);
    expect(slowMotionAt(2000, m)).toBe(1);
    expect(slowMotionAt(1000, m)).toBeCloseTo(0.3, 5);
    expect(slowMotionAt(1000 - 0.45 / dt, m)).toBeLessThan(1);
    expect(slowMotionAt(1000 - 0.45 / dt, m)).toBeGreaterThan(0.3);
  });
});

describe('GameRunner replay', () => {
  it('re-simulates the finished run exactly (same pose at the finish) and ends on the clip end', async () => {
    await initPhysics();
    const pilot = rampDemoPilot({ speed: 38 });
    let live: number[] | null = null;
    let replayed: number[] | null = null;
    let liveCompleted = 0;
    const replayEvents: GameEvent[] = [];
    const st: { status: ReplayStatus | null } = { status: null };
    const runner: GameRunner = new GameRunner({
      sampleInput: () => ({ ...pilot.next(runner.sim!.snapshot) }),
      onEvent: (e) => {
        if (e.type === 'levelComplete') {
          liveCompleted++;
          live = fingerprint(runner.sim!);
        }
      },
      onReplayEvent: (e) => {
        replayEvents.push(e);
        if (e.type === 'levelComplete') replayed = fingerprint(runner.activeSim!);
      },
      onReplay: (s) => (st.status = s),
    });
    runner.countdownEnabled = false;
    runner.load(TEST_RAMP);
    for (let i = 0; i < 60 * 40 && !runner.canReplay; i++) runner.update(1 / 60, i / 60);
    expect(runner.canReplay).toBe(true);
    expect(live).not.toBeNull();
    // let the live run roll out a little, as it does under the results screen
    for (let i = 0; i < 90; i++) runner.update(1 / 60, 100 + i / 60);

    runner.startReplay({ autoSlowmo: true, speed: 1, paused: false });
    expect(runner.replaying).toBe(true);
    for (let i = 0; i < 60 * 120 && st.status?.phase !== 'ended'; i++) runner.update(1 / 60, 200 + i / 60);
    expect(st.status?.phase).toBe('ended');
    expect(st.status?.progress).toBe(1);
    expect(liveCompleted).toBe(1); // the replay never re-reports the result
    expect(replayEvents[0]).toEqual({ type: 'reset' });
    expect(replayed).not.toBeNull();
    for (let i = 0; i < live!.length; i++) expect(Math.abs(live![i] - replayed![i])).toBeLessThan(1e-9);

    runner.stopReplay();
    expect(runner.replaying).toBe(false);
    runner.dispose();
  });

  it('a restart clears the log: the next run has nothing to replay until it finishes', async () => {
    await initPhysics();
    const runner = new GameRunner({ sampleInput: () => ({ ...NEUTRAL_INPUT, throttle: 1 }) });
    runner.countdownEnabled = false;
    runner.load(TEST_RAMP);
    for (let i = 0; i < 120; i++) runner.update(1 / 60, i / 60);
    expect(runner.canReplay).toBe(false);
    runner.dispose();
  });
});
