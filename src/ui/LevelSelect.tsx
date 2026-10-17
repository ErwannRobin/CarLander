/**
 * Level select: three level cards with their elevation profile, what each teaches, unlock
 * state and personal records. Keyboard: arrows move between cards, Enter plays, Esc = back.
 */
import { useLayoutEffect, useMemo, useRef, type Ref } from 'react';
import type { LevelId, LevelProgress } from '@/game/types';
import { requestGyro } from '@/input/gyro';
import { useAppStore } from '@/state/appStore';
import { LEVEL_IDS, useProgressStore } from '@/state/progressStore';
import { Icon } from './components/Icon';
import { LevelProfile } from './components/LevelProfile';
import { Medal } from './components/Medal';
import { QualityBadge } from './components/Controls';
import { MEDAL_LABEL, formatFixed, formatInt } from './format';
import { LEVEL_CATALOG } from './levelCatalog';
import { isShortcutChord, useArrowNav, useAutoFocus, useKeyDown, useRepeatActivationGuard } from './hooks';
import './styles/tokens.css';
import './styles/components.css';
import './styles/screens.css';

function recommendedLevel(levels: Record<LevelId, LevelProgress>): LevelId {
  for (const id of LEVEL_IDS) if (levels[id].unlocked && !levels[id].completed) return id;
  let last: LevelId = 1;
  for (const id of LEVEL_IDS) if (levels[id].unlocked) last = id;
  return last;
}

function LevelCardView({
  id,
  progress,
  recommended,
  onPlay,
  playRef,
}: {
  id: LevelId;
  progress: LevelProgress;
  recommended: boolean;
  onPlay: (id: LevelId) => void;
  playRef?: Ref<HTMLButtonElement>;
}) {
  const card = LEVEL_CATALOG[id];
  const locked = !progress.unlocked;
  const landing = progress.bestLanding;
  return (
    <li className="rf-card" data-theme={card.theme} data-locked={locked || undefined} data-recommended={recommended || undefined}>
      <div className="rf-card__band">
        <LevelProfile id={id} locked={locked} />
        <span className="rf-card__num" aria-hidden="true">
          {id}
        </span>
      </div>
      <div className="rf-card__body">
        <h2 className="rf-card__name">
          <span className="rf-visually-hidden">Level {id}: </span>
          {card.name}
        </h2>
        <p className="rf-card__sub">{card.subtitle}</p>
        <p className="rf-card__desc">{card.description}</p>
        <p className="rf-card__skill">
          <span className="rf-card__skill-label">You learn</span>
          <span className="rf-card__skill-value">{card.skill}</span>
        </p>

        {locked ? (
          <div className="rf-card__lock">
            <Icon name="lock" className="rf-card__lock-icon" />
            <span>{card.requirement ?? 'Locked'}</span>
          </div>
        ) : (
          <dl className="rf-card__stats">
            <div className="rf-card__stat">
              <dt>Best score</dt>
              <dd className="rf-num">{progress.completed ? formatInt(progress.bestScore) : '—'}</dd>
            </div>
            <div className="rf-card__stat">
              <dt>Medal</dt>
              <dd className="rf-card__medal">
                <Medal medal={progress.completed ? progress.bestMedal : 'none'} size="sm" />
                <span>{progress.completed ? MEDAL_LABEL[progress.bestMedal] : '—'}</span>
              </dd>
            </div>
            <div className="rf-card__stat">
              <dt>Best landing</dt>
              <dd>
                {landing ? (
                  <QualityBadge quality={landing.quality}>
                    {landing.quality === 'perfect' ? 'Perfect' : landing.quality === 'clean' ? 'Clean' : 'Hard'}
                    <span className="rf-num rf-card__angle">{formatFixed(landing.angleDeg)}°</span>
                  </QualityBadge>
                ) : (
                  '—'
                )}
              </dd>
            </div>
          </dl>
        )}

        <div className="rf-card__foot">
          <button
            ref={playRef}
            type="button"
            className={`rf-btn rf-card__play ${recommended ? 'rf-btn--primary' : ''}`}
            data-nav
            disabled={locked}
            aria-label={locked ? `${card.name} is locked` : `Play ${card.name}`}
            onClick={() => onPlay(id)}
          >
            {locked ? 'Locked' : progress.completed ? 'Play again' : 'Play'}
          </button>
          {!locked && progress.attempts > 0 && (
            <span className="rf-card__attempts">
              <span className="rf-num">{progress.attempts}</span> {progress.attempts === 1 ? 'attempt' : 'attempts'}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

export function LevelSelect() {
  const overlay = useAppStore((s) => s.overlay);
  const startLevel = useAppStore((s) => s.startLevel);
  const goTitle = useAppStore((s) => s.goTitle);
  const openSettings = useAppStore((s) => s.openSettings);
  const levels = useProgressStore((s) => s.levels);
  const active = overlay === 'none';

  const rec = useMemo(() => recommendedLevel(levels), [levels]);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const recRef = useRef<HTMLButtonElement>(null);
  useAutoFocus(recRef, active);

  // Phones: the cards scroll horizontally and autofocus doesn't scroll — open on the
  // recommended level instead of level 1 (no-op when all cards fit).
  useLayoutEffect(() => {
    const list = listRef.current;
    const card = list?.children[LEVEL_IDS.indexOf(rec)];
    if (!list || !(card instanceof HTMLElement) || list.scrollWidth <= list.clientWidth) return;
    const padLeft = parseFloat(getComputedStyle(list).scrollPaddingLeft) || 0;
    list.scrollLeft += card.getBoundingClientRect().left - list.getBoundingClientRect().left - padLeft;
    // Mount only: later progress changes must not yank the list away from where the player scrolled.
  }, []);
  useArrowNav(rootRef, 'horizontal', active);
  useRepeatActivationGuard();
  useKeyDown(
    (e) => {
      if (isShortcutChord(e)) return;
      if (e.key === 'Escape' || e.key === 'Backspace') {
        e.preventDefault();
        goTitle();
      }
    },
    { enabled: active },
  );

  const play = (id: LevelId) => {
    if (!levels[id].unlocked) return;
    requestGyro(); // no-op once answered; asks now if the title screen did not
    startLevel(id);
  };

  return (
    <div ref={rootRef} className="rf-layer rf-levels" aria-hidden={!active || undefined} inert={!active || undefined}>
      <header className="rf-levels__head">
        <button type="button" className="rf-btn rf-btn--quiet" onClick={goTitle}>
          <Icon name="back" className="rf-btn__icon" />
          Title
        </button>
        <h1 className="rf-levels__title">Select level</h1>
        <button type="button" className="rf-btn rf-btn--quiet" onClick={openSettings}>
          <Icon name="settings" className="rf-btn__icon" />
          Settings
        </button>
      </header>
      <ol ref={listRef} className="rf-levels__cards">
        {LEVEL_IDS.map((id) => (
          <LevelCardView
            key={id}
            id={id}
            progress={levels[id]}
            recommended={id === rec}
            onPlay={play}
            playRef={id === rec ? recRef : undefined}
          />
        ))}
      </ol>
    </div>
  );
}
