/**
 * Static-position HUD panels: objective (top-left), score + icon buttons (top-right) and the
 * compact control guide (bottom-right, toggled with H or the controls button).
 */
import { useState, type MouseEvent } from 'react';
import type { ControlAction, ControlHint } from '@/game/types';
import { keyLabel } from '@/input/keyNames';
import { useAppStore } from '@/state/appStore';
import { useHudStore } from '@/state/hudStore';
import { useSettingsStore } from '@/state/settingsStore';
import { Icon } from '../components/Icon';
import { HintKeys, KeyCap } from '../components/Keys';
import { formatInt, formatMultiplier } from '../format';
import { useGameEvent, useKeyLabelsVersion, useRunReset } from '../hooks';

/* ------------------------------------------------------------------ */
/* Objective                                                           */
/* ------------------------------------------------------------------ */

export function ObjectivePanel() {
  const o = useHudStore((s) => s.objective);
  // Bridges the objectiveComplete event to the next HUD publish. Objective ids repeat across
  // runs, so the flag is dropped on every reset / new run.
  const [completedId, setCompletedId] = useState<string | null>(null);
  useGameEvent('objectiveComplete', (e) => setCompletedId(e.id));
  useRunReset(() => setCompletedId(null));
  if (!o.title) return null;
  const total = Math.max(1, o.total);
  const complete = o.complete || completedId === o.id;
  return (
    <section key={o.id} className="rf-objective rf-glass" data-complete={complete || undefined} aria-live="polite">
      <header className="rf-objective__head">
        <h2 className="rf-objective__title">{o.title}</h2>
        {total > 1 && (
          <ol className="rf-objective__steps" aria-label={`Step ${Math.min(o.index + 1, total)} of ${total}`}>
            {Array.from({ length: total }, (_, i) => (
              <li key={i} data-state={i < o.index || (i === o.index && complete) ? 'done' : i === o.index ? 'current' : 'todo'} />
            ))}
          </ol>
        )}
      </header>
      <p className="rf-objective__text">{o.text}</p>
      {o.hints.length > 0 && (
        <ul className="rf-objective__hints">
          {o.hints.map((h, i) => (
            <li key={`${h.label}-${i}`}>
              <HintKeys hint={h} />
              <span>{h.label}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Score                                                               */
/* ------------------------------------------------------------------ */

export function ScoreReadout() {
  const score = useHudStore((s) => s.score);
  const showChain = score.chain >= 2 || score.comboMultiplier > 1;
  return (
    <div className="rf-score rf-glass" role="group" aria-label={`Score ${score.total}`}>
      <div className="rf-score__row">
        <span className="rf-score__label">Score</span>
        <span key={score.total} className="rf-score__value rf-num" data-bump={score.total > 0 || undefined}>
          {formatInt(score.total)}
        </span>
      </div>
      {showChain && (
        <div className="rf-score__chain">
          <span>
            Chain <span className="rf-num">{score.chain}</span>
          </span>
          <span className="rf-score__mult rf-num">{formatMultiplier(score.comboMultiplier)}</span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Icon buttons                                                        */
/* ------------------------------------------------------------------ */

/** Mouse clicks shouldn't leave focus on HUD buttons (Space/Enter are game keys). */
const keepFocus = (e: MouseEvent) => e.preventDefault();

export function HudButtons({
  guideOpen,
  guideKey,
  onToggleGuide,
}: {
  guideOpen: boolean;
  /** Label of the guide toggle key, or null when that key is bound to a game action. */
  guideKey: string | null;
  onToggleGuide: () => void;
}) {
  const restart = useAppStore((s) => s.restart);
  const pause = useAppStore((s) => s.pause);
  const restartCode = useSettingsStore((s) => s.bindings.restart?.[0]);
  const pauseCode = useSettingsStore((s) => s.bindings.pause?.[0]);
  useKeyLabelsVersion();
  const tip = (name: string, code?: string) => (code ? `${name} (${keyLabel(code)})` : name);
  return (
    <div className="rf-hud__buttons">
      <button
        type="button"
        className="rf-iconbtn"
        aria-label="Controls"
        aria-pressed={guideOpen}
        title={guideKey ? `Controls (${guideKey})` : 'Controls'}
        onMouseDown={keepFocus}
        onClick={onToggleGuide}
      >
        <Icon name="controls" />
      </button>
      <button type="button" className="rf-iconbtn" aria-label="Restart" title={tip('Restart', restartCode)} onMouseDown={keepFocus} onClick={restart}>
        <Icon name="restart" />
      </button>
      <button type="button" className="rf-iconbtn" aria-label="Pause" title={tip('Pause', pauseCode)} onMouseDown={keepFocus} onClick={pause}>
        <Icon name="pause" />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Control guide                                                       */
/* ------------------------------------------------------------------ */

interface GuideRow {
  actions: ControlAction[];
  name: string;
  detail?: string;
  vacuumOnly?: boolean;
}

const GUIDE_ROWS: GuideRow[] = [
  { actions: ['accelerate'], name: 'Accelerate', detail: 'Nose down in the air' },
  { actions: ['brake'], name: 'Brake and reverse', detail: 'Nose up in the air' },
  { actions: ['left', 'right'], name: 'Steer', detail: 'Yaw in the air' },
  { actions: ['rollLeft', 'rollRight'], name: 'Roll', detail: 'In the air' },
  { actions: ['boost'], name: 'Thrusters' },
  { actions: ['stabilize'], name: 'Stabilize', detail: 'Hold to level the car' },
  { actions: ['vacuum'], name: 'Vacuum', detail: 'Hold to stick to the track', vacuumOnly: true },
  { actions: ['restart'], name: 'Restart' },
  { actions: ['pause'], name: 'Pause' },
];

export function ControlGuide({ guideKey, onClose }: { guideKey: string | null; onClose: () => void }) {
  const vacuum = useHudStore((s) => s.vacuum.available);
  return (
    <aside className="rf-guide rf-glass" aria-label="Controls">
      <header className="rf-guide__head">
        <h2 className="rf-guide__title">Controls</h2>
        <button type="button" className="rf-guide__close" onMouseDown={keepFocus} onClick={onClose}>
          {guideKey && <KeyCap label={guideKey} />}
          Hide
        </button>
      </header>
      <dl className="rf-guide__list">
        {GUIDE_ROWS.filter((r) => !r.vacuumOnly || vacuum).map((r) => {
          const hint: ControlHint = { keys: [], label: r.name, actions: r.actions };
          return (
            <div key={r.name} className="rf-guide__row">
              <dt>
                {r.name}
                {r.detail && <span className="rf-guide__detail">{r.detail}</span>}
              </dt>
              <dd>
                <HintKeys hint={hint} />
              </dd>
            </div>
          );
        })}
      </dl>
    </aside>
  );
}
