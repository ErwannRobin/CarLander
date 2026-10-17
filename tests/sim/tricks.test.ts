import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { TEST_FLAT } from '@/game/levels/testLevels';
import { Autopilot, rotateNTimes, stabilizeInAir, cond, type RotationAxis } from '@/game/sim/autopilot';
import { TrickTracker, rotationPoints, trickLabel } from '@/game/sim/TrickTracker';
import type { GameSim } from '@/game/sim/GameSim';
import type { GameEvent, TrickKind } from '@/game/types';
import { createSim, D2R, ofType } from '../physics/helpers';

/** Launches the car straight up from the deck (≈ 3.4 s of air) and runs the trick + stabilize pilot. */
function launchAndPerform(sim: GameSim, axis: RotationAxis, n: number, dir: 1 | -1): GameEvent[] {
  sim.placeVehicle(new Vector3(0, 1.2, 0), new Quaternion(), new Vector3(0, 23, -12));
  sim.drainEvents();
  const pilot = new Autopilot([
    { name: 'trick', controllers: [rotateNTimes(axis, n, dir)], until: (s) => Math.abs(s.air.rotation[axis]) >= n * 360 - 50, timeout: 3 },
    { name: 'stabilize', controllers: [stabilizeInAir()], until: cond.landed(), timeout: 5 },
    { name: 'settle', until: 1.5 },
  ]);
  const events: GameEvent[] = [];
  let recent: GameEvent[] = [];
  for (let i = 0; i < 120 * 8 && !pilot.done; i++) {
    sim.step(pilot.next(sim.snapshot, recent));
    recent = sim.drainEvents();
    events.push(...recent);
  }
  return events;
}

describe('trick detection (real flights)', () => {
  const cases: [string, RotationAxis, number, 1 | -1, TrickKind, string[]][] = [
    ['double backflip', 'pitch', 2, 1, 'backflip', ['BACKFLIP', 'DOUBLE BACKFLIP']],
    ['frontflip', 'pitch', 1, -1, 'frontflip', ['FRONTFLIP']],
    ['360 spin (spins are slower: 3.4 rad/s)', 'yaw', 1, 1, 'spin', ['360 SPIN']],
    ['double barrel roll', 'roll', 2, 1, 'barrelRoll', ['BARREL ROLL', 'DOUBLE BARREL ROLL']],
  ];
  for (const [name, axis, n, dir, kind, labels] of cases) {
    it(`${name}: trick events as rotations complete, counted in the landing`, async () => {
      const sim = await createSim(TEST_FLAT);
      const events = launchAndPerform(sim, axis, n, dir);
      const tricks = ofType(events, 'trick').filter((e) => e.trick.kind === kind);
      expect(tricks.map((e) => e.trick.label)).toEqual(labels);
      expect(tricks.map((e) => e.trick.count)).toEqual(labels.map((_, i) => i + 1));
      const landing = ofType(events, 'landing');
      expect(landing).toHaveLength(1);
      expect(landing[0].result.quality).not.toBe('crash');
      const t = landing[0].result.tricks.find((x) => x.kind === kind)!;
      expect(t.count).toBe(n);
      expect(t.points).toBe(rotationPoints(kind === 'spin' ? 400 : kind === 'barrelRoll' ? 500 : 600, n));
      // tricks are worth points: more than a plain jump of the same air time
      expect(landing[0].result.basePoints).toBeGreaterThan(t.points);
      expect(sim.snapshot.score.tricks).toBeGreaterThanOrEqual(1);
      sim.dispose();
    });
  }

  it('awards HANG TIME after 3 s in the air', async () => {
    const sim = await createSim(TEST_FLAT);
    sim.placeVehicle(new Vector3(0, 1.2, 0), new Quaternion(), new Vector3(0, 23, -12));
    sim.drainEvents();
    const events: GameEvent[] = [];
    for (let i = 0; i < 120 * 5; i++) {
      sim.step({ throttle: 0, steer: 0, roll: 0, boost: false, jump: false, vacuum: false, stabilize: true });
      events.push(...sim.drainEvents());
    }
    const hang = ofType(events, 'trick').filter((e) => e.trick.kind === 'hangTime');
    expect(hang).toHaveLength(1);
    const landing = ofType(events, 'landing')[0].result;
    expect(landing.airTime).toBeGreaterThan(3);
    const final = landing.tricks.find((t) => t.kind === 'hangTime')!;
    expect(final.label).toMatch(/^HANG TIME \d+\.\d s$/);
    expect(final.points).toBeGreaterThanOrEqual(400);
    sim.dispose();
  });
});

describe('TrickTracker (unit)', () => {
  const tick = 1 / 120;
  function spin(t: TrickTracker, axis: 'x' | 'y' | 'z', rateDeg: number, seconds: number, events: GameEvent[]) {
    const w = new Vector3();
    w[axis] = rateDeg * D2R;
    for (let i = 0; i < Math.round(seconds / tick); i++) t.update(w, tick, 0.5, events);
  }

  it('counts a near-complete rotation (≥ 330°) at landing, not below', () => {
    const a = new TrickTracker();
    const ev: GameEvent[] = [];
    spin(a, 'x', 300, 335 / 300, ev);
    expect(ev).toHaveLength(0);
    a.finalize(1.2, ev);
    expect(ev).toHaveLength(1);
    expect(a.tricks[0]).toMatchObject({ kind: 'backflip', count: 1, label: 'BACKFLIP' });

    const b = new TrickTracker();
    const ev2: GameEvent[] = [];
    spin(b, 'x', -300, 320 / 300, ev2);
    b.finalize(1.2, ev2);
    expect(ev2).toHaveLength(0);
    expect(b.tricks).toHaveLength(0);
  });

  it('labels and scales multiples (×1.5 per extra rotation)', () => {
    expect(trickLabel('frontflip', 3)).toBe('TRIPLE FRONTFLIP');
    expect(trickLabel('spin', 3)).toBe('1080 SPIN');
    expect(rotationPoints(600, 1)).toBe(600);
    expect(rotationPoints(600, 2)).toBe(1500);
    expect(rotationPoints(400, 3)).toBe(1900);
  });

  it('integrates roll with + = roll right (negative local Z rate)', () => {
    const t = new TrickTracker();
    const ev: GameEvent[] = [];
    spin(t, 'z', -360, 1.01, ev);
    expect(t.rotation.roll).toBeGreaterThan(359);
    expect(ev[0].type === 'trick' && ev[0].trick.kind).toBe('barrelRoll');
  });
});
