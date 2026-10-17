import { KMH, TUNING } from '../tuning';
import { createScoreState } from '../snapshot';
import type { LandingQuality, LandingResult, LevelDef, LevelResult, ScoreState, TrickInstance } from '../types';

/** Landing multiplier and flat bonus (PERFECT ×2 + 1000, CLEAN ×1.5, HARD ×1, CRASH ⇒ 0). */
export function landingMultiplier(q: LandingQuality): { mult: number; flat: number } {
  const s = TUNING.scoring;
  switch (q) {
    case 'perfect':
      return { mult: s.perfectMult, flat: s.perfectBonus };
    case 'clean':
      return { mult: s.cleanMult, flat: 0 };
    case 'hard':
      return { mult: s.hardMult, flat: 0 };
    default:
      return { mult: 0, flat: 0 };
  }
}

/** Combo multiplier from the number of distinct trick kinds in one jump: 1 + 0.5·(n − 1). */
export function comboMultiplier(distinctTricks: number): number {
  return 1 + TUNING.scoring.comboPerTrick * Math.max(0, distinctTricks - 1);
}

/** Chain multiplier: +0.25 per consecutive quick non-crash landing. */
export function chainMultiplier(chain: number): number {
  return 1 + TUNING.scoring.chainStep * Math.max(0, chain);
}

/** Base points of a jump: airTime·120 + distance·4 + Σ trick points. */
export function jumpBasePoints(airTime: number, distance: number, tricks: readonly TrickInstance[]): number {
  const s = TUNING.scoring;
  let t = 0;
  for (const tr of tricks) t += tr.points;
  return Math.round(airTime * s.airTimePoints + distance * s.distancePoints + t);
}

export interface JumpScore {
  base: number;
  multiplier: number;
  points: number;
}

/** Full jump score (ARCHITECTURE §6). `chain` is the chain count *including* this landing. */
export function scoreJump(
  quality: LandingQuality,
  airTime: number,
  distance: number,
  tricks: readonly TrickInstance[],
  chain: number,
): JumpScore {
  const base = jumpBasePoints(airTime, distance, tricks);
  const kinds = new Set(tricks.map((t) => t.kind)).size;
  const { mult, flat } = landingMultiplier(quality);
  if (mult === 0) return { base, multiplier: 0, points: 0 };
  const multiplier = mult * comboMultiplier(kinds) * chainMultiplier(chain);
  return { base, multiplier, points: Math.round(base * multiplier + flat) };
}

/**
 * Score bookkeeping for one run: totals, chain (consecutive non-crash landings within 3 s of the
 * previous one; reset by a hard landing or crash) and stats.
 */
export class ScoreKeeper {
  readonly state: ScoreState;
  private lastLandingTime = -Infinity;

  constructor(state?: ScoreState) {
    this.state = state ?? createScoreState();
  }

  reset(): void {
    const s = this.state;
    const fresh = createScoreState();
    Object.assign(s, fresh);
    this.lastLandingTime = -Infinity;
  }

  /** Chain count that a landing at `time` with `quality` would produce. */
  chainFor(quality: LandingQuality, time: number): number {
    if (quality === 'crash' || quality === 'hard') return 0;
    return time - this.lastLandingTime <= TUNING.scoring.chainWindow ? this.state.chain + 1 : 0;
  }

  /** Banks a landing (points already computed in `result`). */
  addLanding(result: LandingResult, time: number, chain: number): void {
    const s = this.state;
    s.chain = chain;
    s.comboMultiplier = chainMultiplier(chain);
    s.total += result.points;
    s.lastLanding = result;
    s.tricks += result.tricks.filter((t) => t.kind !== 'hangTime' && t.kind !== 'bullseye').length;
    s.maxAirTime = Math.max(s.maxAirTime, result.airTime);
    s.longestJump = Math.max(s.longestJump, result.distance);
    if (result.quality !== 'crash' && (!s.bestLanding || result.points > s.bestLanding.points)) s.bestLanding = result;
    this.lastLandingTime = time;
  }

  /** Revokes a banked landing that was downgraded to a crash during the settle window. */
  revokeLanding(result: LandingResult): void {
    const s = this.state;
    s.total = Math.max(0, s.total - result.points);
    if (s.bestLanding === result) s.bestLanding = null;
    result.quality = 'crash';
    result.multiplier = 0;
    result.points = 0;
    s.chain = 0;
    s.comboMultiplier = 1;
  }

  onCrash(): void {
    this.state.chain = 0;
    this.state.comboMultiplier = 1;
  }

  addBonus(points: number): void {
    this.state.total += Math.round(points);
  }

  trackSpeed(speed: number): void {
    if (speed > this.state.maxSpeed) this.state.maxSpeed = speed;
  }
}

export function medalFor(level: LevelDef, score: number): LevelResult['medal'] {
  const m = level.medals;
  if (score >= m.gold) return 'gold';
  if (score >= m.silver) return 'silver';
  if (score >= m.bronze) return 'bronze';
  return 'none';
}

function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

const QUALITY_LABEL: Record<LandingQuality, string> = {
  perfect: 'PERFECT',
  clean: 'CLEAN',
  hard: 'HARD',
  crash: 'CRASH',
};

/** Builds the level result: jump points + final landing bonus + time bonus, medal and stats. */
export function buildLevelResult(level: LevelDef, score: ScoreState, time: number, finalLanding: LandingResult): LevelResult {
  const s = TUNING.scoring;
  const q = finalLanding.quality;
  const landingBonus = q === 'crash' ? 0 : s.finalLanding[q];
  const timeBonus = Math.max(0, Math.round((s.timeBonusPar - time) * s.timeBonusPerSec));
  const total = Math.round(score.total + landingBonus + timeBonus);
  const breakdown: LevelResult['breakdown'] = [
    { label: 'Jumps & tricks', value: `${score.jumps} jump${score.jumps === 1 ? '' : 's'} · ${score.tricks} trick${score.tricks === 1 ? '' : 's'}`, points: Math.round(score.total) },
    {
      label: 'Final landing',
      value: `${QUALITY_LABEL[q]} · ${finalLanding.angleDeg.toFixed(1)}° · ${finalLanding.impactSpeed.toFixed(1)} m/s`,
      points: landingBonus,
    },
    { label: 'Time', value: formatTime(time), points: timeBonus },
  ];
  if (score.invertedDistance >= s.invertedMinDistance) {
    breakdown.splice(1, 0, { label: 'Inverted', value: `${Math.round(score.invertedDistance)} m`, points: 0 });
  }
  return {
    levelId: level.id,
    score: total,
    time,
    medal: medalFor(level, total),
    finalLanding,
    bestLanding: score.bestLanding,
    breakdown,
    stats: {
      maxSpeedKmh: Math.round(score.maxSpeed * KMH),
      maxAirTime: score.maxAirTime,
      longestJump: score.longestJump,
      tricks: score.tricks,
      invertedDistance: score.invertedDistance,
    },
  };
}
