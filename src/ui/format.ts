/**
 * Display formatting for the UI (numbers, times, qualities, crash reasons, medals).
 */
import type { CrashReason, LandingQuality, LevelResult } from '@/game/types';

/** Narrow no-break space: thousands separator that never wraps. */
const GROUP = ' ';

/** Placeholder for values that are missing or not finite. */
export const NO_VALUE = '—';

export function formatInt(n: number): string {
  if (!Number.isFinite(n)) return NO_VALUE;
  const v = Math.round(Math.abs(n));
  const s = String(v).replace(/\B(?=(\d{3})+(?!\d))/g, GROUP);
  return n < 0 && v !== 0 ? `−${s}` : s;
}

export function formatPoints(n: number): string {
  if (!Number.isFinite(n)) return NO_VALUE;
  return `${n >= 0 ? '+' : '−'}${formatInt(Math.abs(n))}`;
}

/** m:ss.cc (e.g. 1:14.32). */
export function formatTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '–:––';
  // Work in integer centiseconds so 74.32 doesn't floor to 74.31.
  const total = Math.round(Math.max(0, seconds) * 100);
  const m = Math.floor(total / 6000);
  const s = Math.floor(total / 100) % 60;
  const cs = total % 100;
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export function formatFixed(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : NO_VALUE;
}

export function formatMultiplier(n: number): string {
  if (!Number.isFinite(n)) return `×${NO_VALUE}`;
  const s = Math.abs(n - Math.round(n)) < 0.005 ? String(Math.round(n)) : n.toFixed(2).replace(/0$/, '');
  return `×${s}`;
}

export const QUALITY_LABEL: Record<LandingQuality, string> = {
  perfect: 'Perfect',
  clean: 'Clean',
  hard: 'Hard',
  crash: 'Crash',
};

export const QUALITY_BANNER: Record<LandingQuality, string> = {
  perfect: 'Perfect landing',
  clean: 'Clean landing',
  hard: 'Hard landing',
  crash: 'Crash',
};

/** Plain-language crash explanations (what happened → what to do differently is implied). */
export const CRASH_REASON_TEXT: Record<CrashReason, string> = {
  rollover: 'The car rolled over',
  impact: 'Hit the structure too hard',
  'nose-dive': 'Nose-dived into the surface',
  roof: 'Landed on the roof',
  fell: 'Fell into the clouds',
  'hard-impact': 'Touched down too hard',
  'missed-platform': 'Missed the landing platform',
};

/** Shown when the sim reports a crash without a reason. */
export const CRASH_FALLBACK_TEXT = 'The car crashed';
export const CRASH_FALLBACK_TIP = 'Match the surface angle and touch down gently.';

/** One-line coaching tip per crash reason. */
export const CRASH_REASON_TIP: Record<CrashReason, string> = {
  rollover: 'Keep the wheels under you: roll back upright or hold Stabilize.',
  impact: 'Come in slower or line up straighter with the deck.',
  'nose-dive': 'Pull the nose up before touchdown.',
  roof: 'Flip upright before you land, or hold Stabilize.',
  fell: 'Use the thrusters to carry more distance.',
  'hard-impact': 'Match the slope and land flatter.',
  'missed-platform': 'Aim with yaw and use a short burst of thrust.',
};

export const MEDAL_LABEL: Record<LevelResult['medal'], string> = {
  none: 'No medal',
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
};
