import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { TEST_RAMP } from '@/game/levels/testLevels';
import {
  buildLevelResult,
  chainMultiplier,
  comboMultiplier,
  jumpBasePoints,
  landingMultiplier,
  medalFor,
  ScoreKeeper,
  scoreJump,
} from '@/game/sim/Scoring';
import type { LandingResult, TrickInstance } from '@/game/types';

const trick = (kind: TrickInstance['kind'], points: number): TrickInstance => ({ kind, label: kind, count: 1, points });

function landing(points: number, quality: LandingResult['quality'] = 'clean'): LandingResult {
  return {
    quality,
    angleDeg: 3,
    impactSpeed: 6,
    driftDeg: 1,
    wheelsDown: 4,
    airTime: 2,
    distance: 60,
    maxHeight: 8,
    tricks: [],
    basePoints: points,
    multiplier: 1,
    points,
    inTarget: true,
    position: new Vector3(),
  };
}

describe('scoring', () => {
  it('jump base = airTime·120 + distance·4 + Σ tricks', () => {
    expect(jumpBasePoints(2, 50, [])).toBe(440);
    expect(jumpBasePoints(2, 50, [trick('backflip', 600), trick('spin', 400)])).toBe(1440);
  });

  it('landing × combo × chain multipliers (PERFECT adds a flat 1000)', () => {
    expect(landingMultiplier('perfect')).toEqual({ mult: 2, flat: 1000 });
    expect(landingMultiplier('crash').mult).toBe(0);
    expect(comboMultiplier(0)).toBe(1);
    expect(comboMultiplier(3)).toBe(2);
    expect(chainMultiplier(2)).toBe(1.5);
    const tricks = [trick('backflip', 600), trick('spin', 400)];
    const s = scoreJump('perfect', 2, 50, tricks, 1);
    expect(s.base).toBe(1440);
    expect(s.multiplier).toBeCloseTo(2 * 1.5 * 1.25, 9);
    expect(s.points).toBe(Math.round(1440 * 3.75 + 1000));
    expect(scoreJump('crash', 2, 50, tricks, 3).points).toBe(0);
    expect(scoreJump('hard', 1, 10, [], 0).points).toBe(160);
  });

  it('chains quick non-crash landings; hard landings and crashes reset the chain', () => {
    const k = new ScoreKeeper();
    expect(k.chainFor('clean', 10)).toBe(0); // first landing ever
    k.addLanding(landing(500), 10, 0);
    expect(k.chainFor('perfect', 12)).toBe(1); // within 3 s
    k.addLanding(landing(800, 'perfect'), 12, 1);
    expect(k.state.comboMultiplier).toBe(1.25);
    expect(k.chainFor('clean', 16)).toBe(0); // too late
    expect(k.chainFor('hard', 13)).toBe(0);
    k.onCrash();
    expect(k.state.chain).toBe(0);
    expect(k.state.total).toBe(1300);
    expect(k.state.bestLanding?.points).toBe(800);
  });

  it('revoking a settling landing removes its points and marks it crashed', () => {
    const k = new ScoreKeeper();
    const l = landing(900);
    k.addLanding(l, 5, 0);
    k.revokeLanding(l);
    expect(k.state.total).toBe(0);
    expect(l.quality).toBe('crash');
    expect(l.points).toBe(0);
    expect(k.state.bestLanding).toBeNull();
  });

  it('builds the level result: breakdown sums to the score, medal from thresholds', () => {
    const k = new ScoreKeeper();
    const l = landing(1200, 'perfect');
    k.addLanding(l, 9, 0);
    k.state.jumps = 1;
    const r = buildLevelResult(TEST_RAMP, k.state, 30, l);
    expect(r.breakdown.reduce((a, row) => a + row.points, 0)).toBe(r.score);
    expect(r.score).toBe(1200 + 2500 + (90 - 30) * 40);
    expect(r.medal).toBe(medalFor(TEST_RAMP, r.score));
    expect(medalFor(TEST_RAMP, 0)).toBe('none');
    expect(medalFor(TEST_RAMP, TEST_RAMP.medals.gold)).toBe('gold');
    expect(r.breakdown[0].label).toBe('Jumps & tricks');
    expect(r.breakdown[r.breakdown.length - 1].value).toBe('0:30.0');
  });
});
