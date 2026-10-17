import { describe, expect, it, vi } from 'vitest';
import { Vector3 } from 'three';
import { TEST_FLAT } from '@/game/levels/testLevels';
import { createObjectiveHelpers } from '@/game/sim/objectiveHelpers';
import { ObjectiveRunner } from '@/game/sim/Objectives';
import { createObjectiveState, createSnapshot } from '@/game/snapshot';
import type { GameEvent, LandingResult, LevelDef, ObjectiveContext } from '@/game/types';
import { NEUTRAL_INPUT } from '@/game/types';
import { createSim, input, run } from '../physics/helpers';

function level(objectives: LevelDef['objectives']): LevelDef {
  return { ...TEST_FLAT, objectives };
}

describe('ObjectiveRunner', () => {
  it('runs objectives in order, one per tick, and announces each', () => {
    const flags = { a: false, b: false };
    const lvl = level([
      { id: 'a', title: 'A', text: '', hints: [], complete: () => flags.a },
      { id: 'b', title: 'B', text: '', hints: [], complete: () => flags.b },
      { id: 'fin', title: 'FIN', text: '', hints: [], complete: () => false },
    ]);
    const state = createObjectiveState();
    const r = new ObjectiveRunner(lvl, false, state);
    const out: GameEvent[] = [];
    r.reset(false, 0, out);
    expect(out).toEqual([{ type: 'objective', index: 0, id: 'a', title: 'A' }]);
    const snap = createSnapshot();
    flags.a = flags.b = true; // both true at once: still one completion per tick
    out.length = 0;
    r.update(snap, NEUTRAL_INPUT, [], () => false, 1, out);
    expect(out.map((e) => e.type)).toEqual(['objectiveComplete', 'objective']);
    expect(state).toMatchObject({ index: 1, id: 'b', total: 3, complete: false });
    out.length = 0;
    r.update(snap, NEUTRAL_INPUT, [], () => false, 2, out);
    expect(r.readyForFinish).toBe(true);
    r.completeAll(3, out);
    expect(state.complete).toBe(true);
  });

  it('shows prompts while `when` holds and requests slow-mo only on the first attempt', () => {
    const lvl = level([
      {
        id: 'p',
        title: 'P',
        text: '',
        hints: [],
        complete: () => false,
        prompt: { text: 'HOLD SPACE', when: (ctx) => ctx.input.boost === false, slowMo: 0.4 },
      },
    ]);
    const snap = createSnapshot();
    const first = new ObjectiveRunner(lvl, true, createObjectiveState());
    const out: GameEvent[] = [];
    first.reset(true, 0, out);
    first.update(snap, NEUTRAL_INPUT, [], () => false, 0.1, out);
    expect(first.currentPrompt?.text).toBe('HOLD SPACE');
    expect(first.requestedTimeScale).toBe(0.4);
    expect(out.filter((e) => e.type === 'prompt')).toHaveLength(1);
    first.update(snap, { ...NEUTRAL_INPUT, boost: true }, [], () => false, 0.2, out);
    expect(first.currentPrompt).toBeNull();
    expect(first.requestedTimeScale).toBe(1);
    expect(out.filter((e) => e.type === 'prompt')).toHaveLength(2); // shown, then cleared (null)

    const later = new ObjectiveRunner(lvl, false, createObjectiveState());
    later.reset(false, 0, []);
    later.update(snap, NEUTRAL_INPUT, [], () => false, 0.1, []);
    expect(later.currentPrompt?.text).toBe('HOLD SPACE');
    expect(later.requestedTimeScale).toBe(1);
  });

  it('a throwing level predicate never takes the sim down', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lvl = level([
      {
        id: 'bad',
        title: 'BAD',
        text: '',
        hints: [],
        complete: () => {
          throw new Error('level bug');
        },
      },
    ]);
    const sim = await createSim(lvl);
    run(sim, 0.5, input({ throttle: 1 }));
    expect(sim.snapshot.phase).toBe('running');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    sim.dispose();
  });
});

describe('objective helpers', () => {
  const H = createObjectiveHelpers([{ id: 'pad', purpose: 'target', center: [0, 0, 0], halfSize: [5, 3, 5] }]);
  const landing = (quality: LandingResult['quality'], x: number): GameEvent => ({
    type: 'landing',
    result: { quality, position: new Vector3(x, 0.4, 0) } as LandingResult,
  });
  const ctx = (events: GameEvent[]): ObjectiveContext => ({
    snapshot: createSnapshot(),
    input: NEUTRAL_INPUT,
    events,
    inZone: () => false,
    objectiveTime: 0,
    memory: {},
    firstAttempt: false,
  });

  it('landedIn checks the touchdown position and the minimum quality', () => {
    expect(H.landedIn(ctx([landing('clean', 2)]), 'pad', 'clean')).toBe(true);
    expect(H.landedIn(ctx([landing('hard', 2)]), 'pad', 'clean')).toBe(false);
    expect(H.landedIn(ctx([landing('perfect', 20)]), 'pad')).toBe(false);
    expect(H.landed(ctx([landing('crash', 0)]))).toBe(false);
    expect(H.happened(ctx([{ type: 'takeoff', position: new Vector3(), speed: 1 }]), 'takeoff')).toBe(true);
  });
});
