import { describe, expect, it } from 'vitest';
import { TEST_FLAT } from '@/game/levels/testLevels';
import { classifyLanding, driftAngleDeg, landingRank, type TouchdownSample } from '@/game/sim/LandingEvaluator';
import type { LandingQuality, LevelDef } from '@/game/types';
import { Vector3 } from 'three';
import { createSim, ofType, placeForDrop, run, type DropSpec } from '../physics/helpers';

const sample = (o: Partial<TouchdownSample>): TouchdownSample => ({
  angleDeg: 0,
  impactSpeed: 0,
  driftDeg: 0,
  wheelsDown: 4,
  chassisHit: false,
  ...o,
});

describe('landing classification (thresholds)', () => {
  const table: [string, Partial<TouchdownSample>, LandingQuality][] = [
    ['ideal', {}, 'perfect'],
    ['perfect limits', { angleDeg: 9, impactSpeed: 8, driftDeg: 9 }, 'perfect'],
    ['perfect needs 3 wheels', { wheelsDown: 2 }, 'clean'],
    ['perfect needs no chassis hit', { chassisHit: true }, 'clean'],
    ['angle just over perfect', { angleDeg: 9.5 }, 'clean'],
    ['impact just over perfect', { impactSpeed: 8.2 }, 'clean'],
    ['clean limits', { angleDeg: 24, impactSpeed: 14, driftDeg: 28 }, 'clean'],
    ['angle over clean', { angleDeg: 25 }, 'hard'],
    ['drift over clean', { driftDeg: 30 }, 'hard'],
    ['hard limits', { angleDeg: 50, impactSpeed: 24, driftDeg: 70 }, 'hard'],
    ['angle over hard', { angleDeg: 51 }, 'crash'],
    ['impact over hard', { impactSpeed: 24.5 }, 'crash'],
    ['drift over hard', { driftDeg: 71 }, 'crash'],
  ];
  for (const [name, s, q] of table) {
    it(name, () => expect(classifyLanding(sample(s))).toBe(q));
  }

  it('ranks qualities and measures drift only above the speed threshold', () => {
    expect(landingRank('perfect')).toBeGreaterThan(landingRank('clean'));
    expect(landingRank('hard')).toBeGreaterThan(landingRank('crash'));
    const up = new Vector3(0, 1, 0);
    const fwd = new Vector3(0, 0, -1);
    expect(driftAngleDeg(fwd, new Vector3(2, -10, -2), up)).toBe(0); // 2.8 m/s tangential: ignored
    expect(driftAngleDeg(fwd, new Vector3(10, -10, -10), up)).toBeCloseTo(45, 5);
  });
});

/** Real physics touchdowns with controlled attitude / impact / drift. */
describe('synthetic touchdowns', () => {
  const cases: [string, DropSpec, LandingQuality][] = [
    ['flat soft drop', { impact: 5, rollDeg: 2 }, 'perfect'],
    ['slightly pitched with a little drift', { impact: 6, pitchDeg: 4, driftDeg: 3 }, 'perfect'],
    ['15° roll, 11 m/s, 12° drift', { impact: 11, rollDeg: 15, driftDeg: 12 }, 'clean'],
    ['15° nose-down, 12 m/s', { impact: 12, pitchDeg: -15 }, 'clean'],
    ['30° roll, 19 m/s, 35° drift', { impact: 19, rollDeg: 30, driftDeg: 35 }, 'hard'],
    ['40° roll, 16 m/s', { impact: 16, rollDeg: 40 }, 'hard'],
    ['50° drift', { impact: 8, driftDeg: 50 }, 'hard'],
    ['65° roll', { impact: 10, rollDeg: 65 }, 'crash'],
    ['27 m/s flat', { impact: 27 }, 'crash'],
    ['80° drift', { impact: 8, driftDeg: 80 }, 'crash'],
  ];
  for (const [name, spec, quality] of cases) {
    it(`${name} → ${quality.toUpperCase()}`, async () => {
      const sim = await createSim(TEST_FLAT);
      placeForDrop(sim, spec);
      const events = run(sim, 2.5);
      const landings = ofType(events, 'landing');
      expect(landings.length).toBeGreaterThanOrEqual(1);
      const r = landings[0].result;
      expect(r.quality).toBe(quality);
      const expectedAngle = Math.hypot(spec.rollDeg ?? 0, spec.pitchDeg ?? 0);
      expect(Math.abs(r.angleDeg - expectedAngle)).toBeLessThan(3);
      // tilted cars first touch at a different height than the level-car drop formula assumes
      expect(Math.abs(r.impactSpeed - spec.impact)).toBeLessThan(0.6 + expectedAngle * 0.025);
      expect(Math.abs(r.driftDeg - (spec.driftDeg ?? 0))).toBeLessThan(2);
      expect(ofType(events, 'takeoff')).toHaveLength(1);
      const crashes = ofType(events, 'crash');
      if (quality === 'crash') {
        expect(crashes[0]?.reason).toBe('hard-impact');
        expect(sim.snapshot.phase).toBe('crashed');
        expect(r.points).toBe(0);
      } else {
        expect(crashes).toHaveLength(0);
        expect(r.points).toBeGreaterThan(0);
        expect(sim.snapshot.score.total).toBe(r.points);
      }
      sim.dispose();
    });
  }

  it('PERFECT requests 0.5× slow motion for 0.35 s', async () => {
    const sim = await createSim(TEST_FLAT);
    placeForDrop(sim, { impact: 5 });
    const scales: number[] = [];
    let landedAt = -1;
    run(sim, 1.5, undefined, (t, evs) => {
      if (evs.some((e) => e.type === 'landing')) landedAt = t;
      if (landedAt > 0) scales.push(sim.snapshot.timeScale);
    });
    expect(scales[0]).toBe(0.5);
    const slowTicks = scales.filter((s) => s === 0.5).length;
    expect(slowTicks / 120).toBeCloseTo(0.35, 1);
    expect(scales[scales.length - 1]).toBe(1);
    sim.dispose();
  });

  it('leaving the platform during the settle window downgrades the landing to a crash', async () => {
    const level: LevelDef = {
      ...TEST_FLAT,
      pieces: [{ kind: 'box', id: 'pad', center: [0, -1, 0], size: [20, 2, 14], style: 'platform' }],
      killY: -80,
    };
    const sim = await createSim(level);
    placeForDrop(sim, { impact: 6, horizontal: 14, z: 2 });
    const events = run(sim, 2);
    const landing = ofType(events, 'landing')[0].result;
    const crash = ofType(events, 'crash');
    expect(crash).toHaveLength(1);
    expect(crash[0].reason).toBe('missed-platform');
    expect(landing.quality).toBe('crash'); // downgraded in place
    expect(landing.points).toBe(0);
    expect(sim.snapshot.score.total).toBe(0);
    sim.dispose();
  });
});
