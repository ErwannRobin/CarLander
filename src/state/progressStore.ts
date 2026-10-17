/**
 * Level progression (unlocks, best scores / medals / landings / times, attempts) — persisted.
 *
 * `recordResult` is idempotent per LevelResult object: calling it twice with the same result
 * (e.g. once by the integration and once via appStore.showComplete) returns the same outcome
 * and only records once.
 *
 * URL `?unlockAll=1` unlocks every level (dev / QA convenience).
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { LandingQuality, LandingResult, LevelId, LevelProgress, LevelResult } from '@/game/types';
import { asBool, asFiniteNumber, asOneOf, createSafeStorage, isRecord } from './storage';

export const LEVEL_IDS: readonly LevelId[] = [1, 2, 3];

export type Medal = LevelResult['medal'];
export const MEDAL_RANK: Record<Medal, number> = { none: 0, bronze: 1, silver: 2, gold: 3 };
export const QUALITY_RANK: Record<LandingQuality, number> = { crash: 0, hard: 1, clean: 2, perfect: 3 };
const MEDALS: readonly Medal[] = ['none', 'bronze', 'silver', 'gold'];
const QUALITIES: readonly LandingQuality[] = ['crash', 'hard', 'clean', 'perfect'];

export type BestLanding = NonNullable<LevelProgress['bestLanding']>;

export interface RecordOutcome {
  newBestScore: boolean;
  newBestLanding: boolean;
  /** First time this level was completed. */
  firstCompletion: boolean;
  newBestMedal: boolean;
  newBestTime: boolean;
  /** Level unlocked by this result (null if none / already unlocked). */
  unlocked: LevelId | null;
}

export interface ProgressState {
  levels: Record<LevelId, LevelProgress>;
  recordAttempt(id: LevelId): void;
  recordResult(result: LevelResult): RecordOutcome;
  unlockAll(): void;
  /** Wipe all progress (keeps level 1 unlocked). */
  resetProgress(): void;
}

function emptyProgress(unlocked: boolean): LevelProgress {
  return {
    unlocked,
    completed: false,
    bestScore: 0,
    bestMedal: 'none',
    bestLanding: null,
    bestTime: null,
    attempts: 0,
  };
}

function initialLevels(): Record<LevelId, LevelProgress> {
  return { 1: emptyProgress(true), 2: emptyProgress(false), 3: emptyProgress(false) };
}

function toBestLanding(l: LandingResult): BestLanding {
  return { quality: l.quality, angleDeg: l.angleDeg, impactSpeed: l.impactSpeed, points: l.points };
}

/** True if landing `a` is strictly better than `b`: quality, then points, then smaller angle. */
export function isBetterLanding(a: BestLanding, b: BestLanding | null): boolean {
  if (!b) return true;
  const dq = QUALITY_RANK[a.quality] - QUALITY_RANK[b.quality];
  if (dq !== 0) return dq > 0;
  if (a.points !== b.points) return a.points > b.points;
  return a.angleDeg < b.angleDeg;
}

function nextLevelId(id: LevelId): LevelId | null {
  return id === 1 ? 2 : id === 2 ? 3 : null;
}

const recorded = new WeakMap<LevelResult, RecordOutcome>();

function sanitizeLanding(raw: unknown): BestLanding | null {
  if (!isRecord(raw)) return null;
  return {
    quality: asOneOf(raw.quality, QUALITIES, 'hard'),
    angleDeg: asFiniteNumber(raw.angleDeg, 0),
    impactSpeed: asFiniteNumber(raw.impactSpeed, 0),
    points: asFiniteNumber(raw.points, 0),
  };
}

function sanitizeLevel(raw: unknown, fallback: LevelProgress): LevelProgress {
  if (!isRecord(raw)) return fallback;
  const bestTime = raw.bestTime;
  return {
    unlocked: asBool(raw.unlocked, fallback.unlocked),
    completed: asBool(raw.completed, fallback.completed),
    bestScore: Math.max(0, asFiniteNumber(raw.bestScore, fallback.bestScore)),
    bestMedal: asOneOf(raw.bestMedal, MEDALS, fallback.bestMedal),
    bestLanding: sanitizeLanding(raw.bestLanding),
    bestTime: typeof bestTime === 'number' && Number.isFinite(bestTime) && bestTime > 0 ? bestTime : null,
    attempts: Math.max(0, Math.floor(asFiniteNumber(raw.attempts, fallback.attempts))),
  };
}

function sanitizeLevels(raw: unknown): Record<LevelId, LevelProgress> {
  const out = initialLevels();
  if (!isRecord(raw)) return out;
  for (const id of LEVEL_IDS) out[id] = sanitizeLevel(raw[String(id)], out[id]);
  out[1].unlocked = true;
  // A completed level always unlocks the next one (repairs inconsistent saves).
  for (const id of LEVEL_IDS) {
    const n = nextLevelId(id);
    if (n && out[id].completed) out[n].unlocked = true;
  }
  return out;
}

export const PROGRESS_STORAGE_KEY = 'roadster-flight.progress';
const PROGRESS_VERSION = 1;

type PersistedProgress = Pick<ProgressState, 'levels'>;

export const useProgressStore = create<ProgressState>()(
  persist(
    (set, get) => ({
      levels: initialLevels(),

      recordAttempt: (id) => {
        const levels = get().levels;
        set({ levels: { ...levels, [id]: { ...levels[id], attempts: levels[id].attempts + 1 } } });
      },

      recordResult: (result) => {
        const cached = recorded.get(result);
        if (cached) return cached;

        const id = result.levelId;
        const levels = { ...get().levels };
        const prev = levels[id];

        // Best landing of the run: the better of the final landing and the run's best landing.
        let candidate = toBestLanding(result.finalLanding);
        if (result.bestLanding && result.bestLanding.quality !== 'crash') {
          const best = toBestLanding(result.bestLanding);
          if (isBetterLanding(best, candidate)) candidate = best;
        }

        const newBestScore = result.score > prev.bestScore;
        const newBestLanding = candidate.quality !== 'crash' && isBetterLanding(candidate, prev.bestLanding);
        const newBestMedal = MEDAL_RANK[result.medal] > MEDAL_RANK[prev.bestMedal];
        const newBestTime = result.time > 0 && (prev.bestTime === null || result.time < prev.bestTime);

        levels[id] = {
          ...prev,
          unlocked: true,
          completed: true,
          bestScore: newBestScore ? result.score : prev.bestScore,
          bestMedal: newBestMedal ? result.medal : prev.bestMedal,
          bestLanding: newBestLanding ? candidate : prev.bestLanding,
          bestTime: newBestTime ? result.time : prev.bestTime,
        };

        let unlocked: LevelId | null = null;
        const n = nextLevelId(id);
        if (n && !levels[n].unlocked) {
          levels[n] = { ...levels[n], unlocked: true };
          unlocked = n;
        }

        const outcome: RecordOutcome = {
          newBestScore,
          newBestLanding,
          firstCompletion: !prev.completed,
          newBestMedal,
          newBestTime,
          unlocked,
        };
        recorded.set(result, outcome);
        set({ levels });
        return outcome;
      },

      unlockAll: () => {
        const levels = { ...get().levels };
        for (const id of LEVEL_IDS) if (!levels[id].unlocked) levels[id] = { ...levels[id], unlocked: true };
        set({ levels });
      },

      resetProgress: () => set({ levels: initialLevels() }),
    }),
    {
      name: PROGRESS_STORAGE_KEY,
      version: PROGRESS_VERSION,
      storage: createSafeStorage<PersistedProgress>(),
      partialize: (s) => ({ levels: s.levels }),
      migrate: (persisted) => persisted as PersistedProgress,
      merge: (persisted, current) => ({
        ...current,
        levels: isRecord(persisted) ? sanitizeLevels(persisted.levels) : current.levels,
      }),
    },
  ),
);

function urlRequestsUnlockAll(): boolean {
  try {
    return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('unlockAll') === '1';
  } catch {
    return false;
  }
}

if (urlRequestsUnlockAll()) {
  // Deferred by a microtask so code that re-targets the persisted key right after importing
  // this module (the dev sandbox does) is respected; in the game this is equivalent to "now".
  const unlock = () => queueMicrotask(() => useProgressStore.getState().unlockAll());
  if (useProgressStore.persist.hasHydrated()) unlock();
  else useProgressStore.persist.onFinishHydration(unlock);
}

/** Is `id` playable? */
export function isLevelUnlocked(id: LevelId): boolean {
  return useProgressStore.getState().levels[id]?.unlocked ?? id === 1;
}
