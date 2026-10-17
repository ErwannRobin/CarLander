/**
 * Pause menu: a side sheet over the dimmed scene. Resume, Restart, Settings, Level select,
 * Quit to title. Keyboard: arrows move, Enter selects, Esc (or any pause binding) resumes, the
 * restart binding restarts — the shortcuts shown on the menu items work here (gameplay input is
 * disabled while paused, so the menu handles them itself).
 */
import { useRef } from 'react';
import { useAppStore } from '@/state/appStore';
import { useHudStore } from '@/state/hudStore';
import { useSettingsStore } from '@/state/settingsStore';
import { Icon } from './components/Icon';
import { ShortcutKey } from './components/Keys';
import { formatInt, formatTime } from './format';
import { LEVEL_CATALOG } from './levelCatalog';
import { isShortcutChord, useArrowNav, useAutoFocus, useKeyDown, useRepeatActivationGuard } from './hooks';
import './styles/tokens.css';
import './styles/components.css';
import './styles/overlays.css';

export function PauseMenu() {
  const levelId = useAppStore((s) => s.levelId);
  const resume = useAppStore((s) => s.resume);
  const restart = useAppStore((s) => s.restart);
  const openSettings = useAppStore((s) => s.openSettings);
  const goLevelSelect = useAppStore((s) => s.goLevelSelect);
  const goTitle = useAppStore((s) => s.goTitle);
  const objective = useHudStore((s) => s.objective);
  const score = useHudStore((s) => s.score.total);
  const time = useHudStore((s) => s.time);
  const pauseCodes = useSettingsStore((s) => s.bindings.pause);
  const restartCodes = useSettingsStore((s) => s.bindings.restart);

  const menuRef = useRef<HTMLElement>(null);
  const resumeRef = useRef<HTMLButtonElement>(null);
  useAutoFocus(resumeRef);
  useArrowNav(menuRef, 'vertical');
  useRepeatActivationGuard();
  useKeyDown((e) => {
    if (e.repeat || isShortcutChord(e)) return;
    if (e.key === 'Escape' || pauseCodes?.includes(e.code)) {
      e.preventDefault();
      resume();
    } else if (restartCodes?.includes(e.code)) {
      e.preventDefault();
      restart();
    }
  });

  const card = LEVEL_CATALOG[levelId];
  const total = Math.max(objective.total, 1);
  return (
    <div className="rf-layer rf-overlay rf-pause" role="dialog" aria-modal="true" aria-labelledby="rf-pause-title">
      <div className="rf-pause__scrim" aria-hidden="true" />
      <aside className="rf-pause__sheet">
        <header className="rf-pause__head">
          <h1 id="rf-pause-title" className="rf-pause__title">
            Paused
          </h1>
          <p className="rf-pause__level">
            <span className="rf-pause__level-num">Level {levelId}</span>
            <span className="rf-pause__level-name">{card.name}</span>
          </p>
        </header>

        <dl className="rf-pause__stats">
          {objective.title && (
            <div className="rf-pause__stat rf-pause__stat--wide">
              <dt>
                Objective <span className="rf-num">{Math.min(objective.index + 1, total)}</span> of{' '}
                <span className="rf-num">{total}</span>
              </dt>
              <dd>{objective.title}</dd>
            </div>
          )}
          <div className="rf-pause__stat">
            <dt>Score</dt>
            <dd className="rf-num">{formatInt(score)}</dd>
          </div>
          <div className="rf-pause__stat">
            <dt>Run time</dt>
            <dd className="rf-num">{formatTime(time)}</dd>
          </div>
        </dl>

        <nav ref={menuRef} className="rf-menu" aria-label="Pause menu">
          <button ref={resumeRef} type="button" className="rf-menu__item rf-menu__item--primary" data-nav onClick={resume}>
            <Icon name="play" className="rf-menu__icon" />
            <span className="rf-menu__label">Resume</span>
            <ShortcutKey action="pause" />
          </button>
          <button type="button" className="rf-menu__item" data-nav onClick={restart}>
            <Icon name="restart" className="rf-menu__icon" />
            <span className="rf-menu__label">Restart</span>
            <ShortcutKey action="restart" />
          </button>
          <button type="button" className="rf-menu__item" data-nav onClick={openSettings}>
            <Icon name="settings" className="rf-menu__icon" />
            <span className="rf-menu__label">Settings</span>
          </button>
          <button type="button" className="rf-menu__item" data-nav onClick={goLevelSelect}>
            <Icon name="back" className="rf-menu__icon" />
            <span className="rf-menu__label">Level select</span>
          </button>
          <span className="rf-menu__sep" aria-hidden="true" />
          <button type="button" className="rf-menu__item rf-menu__item--quiet" data-nav onClick={goTitle}>
            <Icon name="close" className="rf-menu__icon" />
            <span className="rf-menu__label">Quit to title</span>
          </button>
        </nav>
      </aside>
    </div>
  );
}
