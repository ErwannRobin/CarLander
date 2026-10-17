/**
 * Title screen, drawn over the live 3D car preview (rendered behind by integration).
 * Content sits in the left column; the centre-right of the frame stays open for the car.
 * Keyboard: Enter = Play (Play is focused on arrival), arrows move between actions.
 */
import { useRef } from 'react';
import { requestGyro } from '@/input/gyro';
import { useAppStore } from '@/state/appStore';
import { LEVEL_IDS, useProgressStore } from '@/state/progressStore';
import { Icon } from './components/Icon';
import { KeyCap } from './components/Keys';
import { Medal } from './components/Medal';
import { useArrowNav, useAutoFocus, useInputMode, useKeyDown, useRepeatActivationGuard } from './hooks';
import './styles/tokens.css';
import './styles/components.css';
import './styles/screens.css';

const WORD_TOP = 'Roadster';
const WORD_BOTTOM = 'FLIGHT';

export function TitleScreen() {
  const overlay = useAppStore((s) => s.overlay);
  const goLevelSelectRaw = useAppStore((s) => s.goLevelSelect);
  const openSettings = useAppStore((s) => s.openSettings);
  const levels = useProgressStore((s) => s.levels);
  const mode = useInputMode();
  const active = overlay === 'none';

  // Play is the tap that asks for the motion sensor (iOS only shows its prompt from a user gesture)
  const goLevelSelect = () => {
    requestGyro();
    goLevelSelectRaw();
  };

  const rootRef = useRef<HTMLDivElement>(null);
  const playRef = useRef<HTMLButtonElement>(null);
  useAutoFocus(playRef, active);
  useArrowNav(rootRef, 'both', active);
  useRepeatActivationGuard();
  useKeyDown(
    (e) => {
      // Enter plays unless another control has focus (then the browser activates that control).
      if (e.key === 'Enter' && !e.repeat && (document.activeElement === document.body || document.activeElement === null)) {
        e.preventDefault();
        goLevelSelect();
      }
    },
    { enabled: active },
  );

  const completed = LEVEL_IDS.filter((id) => levels[id].completed).length;

  return (
    <div ref={rootRef} className="rf-layer rf-title" aria-hidden={!active || undefined} inert={!active || undefined}>
      <main className="rf-title__col">
        <h1 className="rf-wordmark" aria-label="Roadster Flight">
          <span className="rf-wordmark__top" aria-hidden="true">
            {WORD_TOP}
          </span>
          <span className="rf-wordmark__bottom" aria-hidden="true">
            {WORD_BOTTOM.split('').map((c, i) => (
              <span key={i}>{c}</span>
            ))}
          </span>
        </h1>
        <div className="rf-title__rule" aria-hidden="true">
          <span className="rf-title__rule-line" />
          <span className="rf-title__rule-tick" />
        </div>
        <p className="rf-title__tagline">
          Launch a rocket-assisted roadster off monumental ramps above the clouds. Then land it perfectly.
        </p>
        <div className="rf-title__actions">
          <button ref={playRef} type="button" className="rf-btn rf-btn--primary rf-title__play" data-nav onClick={goLevelSelect}>
            Play
            {mode !== 'gamepad' && <KeyCap label="Enter" />}
          </button>
          <button type="button" className="rf-btn" data-nav onClick={openSettings}>
            <Icon name="settings" className="rf-btn__icon" />
            Settings
          </button>
        </div>
        <p className="rf-title__hint">Drag to turn the car · pinch or scroll to zoom</p>
      </main>

      <footer className="rf-title__foot">
        <div className="rf-title__progress" aria-label={`${completed} of ${LEVEL_IDS.length} levels complete`}>
          <span className="rf-title__medals" aria-hidden="true">
            {LEVEL_IDS.map((id) => (
              <Medal key={id} medal={levels[id].completed ? levels[id].bestMedal : 'none'} size="sm" />
            ))}
          </span>
          <span className="rf-title__progress-text">
            {completed === 0
              ? 'Three levels. Start with Learn to Fly.'
              : completed === LEVEL_IDS.length
                ? 'All levels complete'
                : `${completed} of ${LEVEL_IDS.length} levels complete`}
          </span>
        </div>
        <div className="rf-ruler" aria-hidden="true">
          <span className="rf-ruler__track" />
        </div>
      </footer>
    </div>
  );
}
