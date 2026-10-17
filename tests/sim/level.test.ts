import { describe, expect, it } from 'vitest';
import { TEST_RAMP, TEST_VACUUM } from '@/game/levels/testLevels';
import { runAutopilot } from '@/game/sim/autopilot';
import { demoPilotFor, rampDemoPilot, vacuumDemoPilot } from '@/game/sim/demoPilots';
import type { GameEvent } from '@/game/types';
import { createSim, KMH, ofType } from '../physics/helpers';

const summary = (events: GameEvent[]) =>
  events
    .filter((e) => ['objective', 'objectiveComplete', 'takeoff', 'landing', 'levelComplete'].includes(e.type))
    .map((e) => ('id' in e ? `${e.type}:${e.id}` : e.type));

describe('levels via autopilot', () => {
  it('TEST_RAMP: objectives complete in order and the level finishes with a result', async () => {
    const sim = await createSim(TEST_RAMP);
    const report = runAutopilot(sim, rampDemoPilot({ speed: 40 }), { maxTime: 30 });
    expect(report.stoppedBy).toBe('complete');
    expect(summary(report.events)).toEqual([
      'objective:ramp-speed',
      'objectiveComplete:ramp-speed',
      'objective:ramp-jump',
      'takeoff',
      'objectiveComplete:ramp-jump',
      'objective:ramp-land',
      'landing',
      'objectiveComplete:ramp-land',
      'levelComplete',
    ]);
    // the jump: takeoff at the kicker lip, ≥ CLEAN with the stabilizer, in the target zone
    const takeoff = ofType(report.events, 'takeoff')[0];
    expect(takeoff.position.z).toBeLessThan(-270);
    expect(takeoff.position.z).toBeGreaterThan(-285);
    const landing = ofType(report.events, 'landing')[0].result;
    expect(['perfect', 'clean']).toContain(landing.quality);
    expect(landing.angleDeg).toBeLessThan(5);
    expect(landing.airTime).toBeGreaterThan(1.5);
    expect(landing.distance).toBeGreaterThan(50);
    expect(landing.inTarget).toBe(true);
    // level result
    const done = ofType(report.events, 'levelComplete')[0].result;
    expect(sim.snapshot.phase).toBe('complete');
    expect(sim.snapshot.result).toBe(done);
    expect(sim.snapshot.objective.complete).toBe(true);
    expect(done.levelId).toBe(TEST_RAMP.id);
    expect(done.finalLanding).toBe(landing);
    expect(done.score).toBeGreaterThan(landing.points);
    expect(done.breakdown.length).toBeGreaterThanOrEqual(3);
    expect(done.breakdown.reduce((a, r) => a + r.points, 0)).toBe(done.score);
    expect(['bronze', 'silver', 'gold']).toContain(done.medal);
    expect(done.stats.maxSpeedKmh).toBeGreaterThan(130);
    expect(done.stats.longestJump).toBeCloseTo(landing.distance, 5);
    expect(done.time).toBeGreaterThan(5);
    expect(done.time).toBeLessThan(20);
    sim.dispose();
  });

  it('TEST_RAMP: a backflip run scores more than a plain run', async () => {
    const plain = await createSim(TEST_RAMP);
    const p = runAutopilot(plain, rampDemoPilot({ speed: 40 }), { maxTime: 30 });
    const flip = await createSim(TEST_RAMP);
    const f = runAutopilot(flip, rampDemoPilot({ speed: 40, backflips: 1 }), { maxTime: 30 });
    const flipLanding = ofType(f.events, 'landing')[0].result;
    expect(flipLanding.tricks.some((t) => t.kind === 'backflip')).toBe(true);
    expect(flipLanding.quality).not.toBe('crash');
    expect(flipLanding.points).toBeGreaterThan(ofType(p.events, 'landing')[0].result.points);
    plain.dispose();
    flip.dispose();
  });

  it('TEST_RAMP first attempt: the stabilize prompt requests bullet-time until Shift is held', async () => {
    const sim = await createSim(TEST_RAMP, { firstAttempt: true });
    const pilot = rampDemoPilot({ speed: 40 });
    const shown: number[] = [];
    let recent: GameEvent[] = [];
    let cleared = false;
    for (let i = 0; i < 120 * 14 && sim.snapshot.phase !== 'complete'; i++) {
      const inp = { ...pilot.next(sim.snapshot, recent) };
      // a hesitant player: no Shift for the first 0.6 s of flight
      if (sim.snapshot.air.airborne && sim.snapshot.air.airTime < 0.6) inp.stabilize = false;
      sim.step(inp);
      recent = sim.drainEvents();
      if (sim.snapshot.prompt) shown.push(sim.snapshot.timeScale);
      else if (shown.length > 0) cleared = true;
    }
    expect(shown.length).toBeGreaterThan(10);
    expect(shown.every((s) => s === 0.6)).toBe(true);
    expect(cleared).toBe(true);
    expect(sim.snapshot.phase).toBe('complete');
    sim.dispose();

    // not on later attempts
    const again = await createSim(TEST_RAMP, { firstAttempt: false });
    let minScale = 1;
    runAutopilot(again, rampDemoPilot({ speed: 40 }), {
      maxTime: 30,
      onTick: (s) => {
        if (s.snapshot.prompt) minScale = Math.min(minScale, s.snapshot.timeScale);
      },
    });
    expect(minScale).toBe(1);
    again.dispose();
  });

  it('TEST_VACUUM: engage, climb, drive inverted, release and land → level complete', async () => {
    const sim = await createSim(TEST_VACUUM, { flightAssist: true });
    const report = runAutopilot(sim, vacuumDemoPilot({ speed: 26 }), { maxTime: 45 });
    expect(report.stoppedBy).toBe('complete');
    const ids = ofType(report.events, 'objectiveComplete').map((e) => e.id);
    expect(ids).toEqual(['vac-engage', 'vac-inverted', 'vac-land']);
    const inverted = ofType(report.events, 'trick').find((e) => e.trick.kind === 'inverted');
    expect(inverted).toBeDefined();
    expect(inverted!.trick.label).toMatch(/^INVERTED \d+ m$/);
    const landing = ofType(report.events, 'landing')[0].result;
    expect(landing.quality).not.toBe('crash');
    expect(landing.tricks.some((t) => t.kind === 'inverted')).toBe(true); // carried into the release jump
    expect(sim.snapshot.score.invertedDistance).toBeGreaterThan(60);
    expect(sim.snapshot.result?.stats.invertedDistance).toBeGreaterThan(60);
    expect(sim.snapshot.result?.stats.maxSpeedKmh).toBeGreaterThan(90);
    expect(sim.snapshot.vehicle.speed * KMH).toBeLessThan(200);
    sim.dispose();
  });

  it('TEST_VACUUM: manual Q/E roll recovery after the release also lands', async () => {
    const sim = await createSim(TEST_VACUUM);
    const report = runAutopilot(sim, vacuumDemoPilot({ speed: 26, manualRoll: true }), { maxTime: 45 });
    const landing = ofType(report.events, 'landing')[0]?.result;
    expect(landing).toBeDefined();
    expect(landing.quality).not.toBe('crash');
    sim.dispose();
  });

  it('demoPilotFor matches re-labelled copies of the test levels (e.g. TEST_RAMP standing in for level 2)', () => {
    expect(demoPilotFor({ ...TEST_RAMP, id: 2 })).not.toBeNull();
    expect(demoPilotFor({ ...TEST_VACUUM, name: 'L3 stand-in' })).not.toBeNull();
    expect(demoPilotFor({ ...TEST_RAMP, pieces: [] })).toBeNull();
  });

  it('demo pilots complete through asFunction() — the devHooks.autopilot path (snapshot only, no events)', async () => {
    for (const lvl of [TEST_RAMP, TEST_VACUUM]) {
      const sim = await createSim(lvl);
      const fn = demoPilotFor(lvl)!.asFunction();
      for (let i = 0; i < 120 * 40 && sim.snapshot.phase !== 'complete'; i++) {
        sim.step(fn(sim.snapshot));
        sim.drainEvents();
      }
      expect(sim.snapshot.phase).toBe('complete');
      // the same function survives a sim reset (it restarts its phases when time goes backwards)
      sim.reset();
      for (let i = 0; i < 120 * 40 && sim.snapshot.phase !== 'complete'; i++) sim.step(fn(sim.snapshot));
      expect(sim.snapshot.phase).toBe('complete');
      sim.dispose();
    }
  });
});
