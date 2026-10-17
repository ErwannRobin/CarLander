/**
 * Crash feedback: what went wrong in plain words, one coaching tip, the retry key and a note
 * that the run restarts by itself.
 *
 * Visible while the HUD phase is `crashed`; the `crash` event shows it immediately (before the
 * next ~30 Hz HUD publish) and provides the reason. `reset` (or a new run nonce) hides it at
 * once, even if the HUD store still says `crashed` until the next publish. The auto-restart line
 * freezes while the sim is paused.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { CrashReason } from '@/game/types';
import { selectSimPaused, useAppStore } from '@/state/appStore';
import { useHudStore } from '@/state/hudStore';
import { Icon } from './components/Icon';
import { ActionKeys } from './components/Keys';
import { CRASH_FALLBACK_TEXT, CRASH_FALLBACK_TIP, CRASH_REASON_TEXT, CRASH_REASON_TIP } from './format';
import { useGameEvent, useInputMode, useRunReset } from './hooks';
import './styles/tokens.css';
import './styles/components.css';
import './styles/overlays.css';

export interface CrashBannerProps {
  /**
   * Delay before the runner restarts automatically (ms). Drives the progress line.
   * Default 1700 = GameRunner's CRASH_RESTART_DELAY; pass the real value if it changes.
   */
  autoRestartMs?: number;
}

/** Matches GameRunner's crash auto-restart delay (1.7 s real time). */
export const DEFAULT_AUTO_RESTART_MS = 1700;

let nextId = 1;
/** How long the event alone keeps the banner up while waiting for the HUD phase. */
const BRIDGE_MS = 400;

export function CrashBanner({ autoRestartMs = DEFAULT_AUTO_RESTART_MS }: CrashBannerProps) {
  const phase = useHudStore((s) => s.phase);
  const hudReason = useHudStore((s) => s.crashReason);
  const paused = useAppStore(selectSimPaused);
  const mode = useInputMode();
  const [crash, setCrash] = useState<{ id: number; reason: CrashReason } | null>(null);
  const [bridging, setBridging] = useState(false);
  /** A `reset` arrived: stay hidden until the HUD phase catches up (leaves `crashed`). */
  const [dismissed, setDismissed] = useState(false);
  const timer = useRef(0);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  // Any phase change means the HUD caught up with the reset (or a new crash began).
  useEffect(() => setDismissed(false), [phase]);

  useGameEvent('crash', (e) => {
    setCrash({ id: nextId++, reason: e.reason });
    setDismissed(false);
    setBridging(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setBridging(false), BRIDGE_MS);
  });
  // A reset (or a new run) hides the banner at once, even before the HUD phase catches up.
  useRunReset(() => {
    window.clearTimeout(timer.current);
    setBridging(false);
    setCrash(null);
    setDismissed(true);
  });

  const visible = bridging || (phase === 'crashed' && !dismissed);
  if (!visible) return null;
  const reason = crash?.reason ?? hudReason;
  const restartMs = Number.isFinite(autoRestartMs) && autoRestartMs > 0 ? autoRestartMs : DEFAULT_AUTO_RESTART_MS;

  return (
    <div className="rf-layer rf-crash-layer" aria-live="assertive" data-paused={paused || undefined}>
      <div className="rf-crash-vignette" aria-hidden="true" />
      <div key={crash?.id ?? 0} className="rf-crash" role="alert" style={{ '--restart': `${restartMs}ms` } as CSSProperties}>
        <div className="rf-crash__word">Crash</div>
        <div className="rf-crash__reason">{reason ? CRASH_REASON_TEXT[reason] : CRASH_FALLBACK_TEXT}</div>
        <div className="rf-crash__tip">{reason ? CRASH_REASON_TIP[reason] : CRASH_FALLBACK_TIP}</div>
        <div className="rf-crash__foot">
          <span className="rf-crash__retry">
            {mode === 'touch' ? (
              <>
                Tap <Icon name="restart" /> to retry now
              </>
            ) : (
              <>
                <ActionKeys action="restart" />
                Retry now
              </>
            )}
          </span>
          <span className="rf-crash__auto">
            <span className="rf-crash__bar" aria-hidden="true">
              <span />
            </span>
            Restarting automatically
          </span>
        </div>
      </div>
    </div>
  );
}
