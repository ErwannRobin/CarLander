/**
 * Replay of the last seconds of a finished run, over the live 3D view: spectator or chase camera,
 * director slow motion, manual speed, and export of the clip as a video file.
 *
 * The scene itself is driven by the game controller (see GameController / GameRunner.startReplay);
 * this panel only shows its state and sends commands. Esc / pause key goes back to the results,
 * Space pauses, the restart key plays the clip again.
 */
import { useRef } from 'react';
import { useAppStore } from '@/state/appStore';
import { replayControl, useReplayStore, type ReplayCamera, type ReplaySpeed } from '@/state/replayStore';
import { useSettingsStore } from '@/state/settingsStore';
import { Icon } from './components/Icon';
import { formatInt } from './format';
import { LEVEL_CATALOG } from './levelCatalog';
import { isShortcutChord, useArrowNav, useAutoFocus, useKeyDown, useRepeatActivationGuard } from './hooks';
import './styles/tokens.css';
import './styles/components.css';
import './styles/overlays.css';

const SPEEDS: Array<{ value: ReplaySpeed; label: string }> = [
  { value: 1, label: '1×' },
  { value: 0.5, label: '½×' },
  { value: 0.25, label: '¼×' },
];
const CAMERAS: Array<{ value: ReplayCamera; label: string }> = [
  { value: 'spectator', label: 'Spectator' },
  { value: 'chase', label: 'Chase' },
];

export function ReplayView() {
  const levelId = useAppStore((s) => s.levelId);
  const closeReplay = useAppStore((s) => s.closeReplay);
  const st = useReplayStore();
  const pauseCodes = useSettingsStore((s) => s.bindings.pause);
  const restartCodes = useSettingsStore((s) => s.bindings.restart);

  const rootRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  useAutoFocus(backRef);
  useArrowNav(rootRef, 'horizontal');
  useRepeatActivationGuard();

  const recording = st.exportPhase === 'recording';
  const seeking = st.phase === 'seeking';
  const ready = !seeking && st.phase !== 'idle';
  const togglePause = () => {
    if (ready && !recording && st.phase === 'playing') st.set({ paused: !st.paused });
  };
  useKeyDown((e) => {
    if (e.repeat || isShortcutChord(e)) return;
    if (e.key === 'Escape' || pauseCodes?.includes(e.code)) {
      e.preventDefault();
      closeReplay();
    } else if (e.code === 'Space' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      togglePause();
    } else if (restartCodes?.includes(e.code) && !recording) {
      e.preventDefault();
      replayControl.restart();
    }
  });

  const card = LEVEL_CATALOG[levelId];
  const slow = st.phase === 'playing' && st.scale < 0.95;
  const pct = (v: number) => `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%`;

  return (
    <div ref={rootRef} className="rf-layer rf-overlay rf-replay" role="dialog" aria-modal="true" aria-labelledby="rf-replay-title">
      <header className="rf-replay__top">
        <span className="rf-replay__tag" id="rf-replay-title">
          <span className={`rf-replay__dot${recording ? ' rf-replay__dot--rec' : ''}`} aria-hidden="true" />
          {recording ? 'Recording' : 'Replay'}
        </span>
        <span className="rf-replay__where">
          Level {levelId} · {card.name}
        </span>
        {slow && <span className="rf-replay__slow rf-num">SLOW-MO {formatInt(st.scale * 100)}%</span>}
      </header>

      {seeking && (
        <div className="rf-replay__prep" role="status">
          <span>Preparing replay</span>
          <span className="rf-replay__prep-bar" aria-hidden="true">
            <i style={{ width: pct(st.seek) }} />
          </span>
        </div>
      )}

      <footer className="rf-replay__bar rf-glass">
        <div
          className="rf-replay__track"
          role="progressbar"
          aria-label="Replay position"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(st.progress * 100)}
        >
          <i style={{ width: pct(st.progress) }} />
        </div>

        <div className="rf-replay__row">
          <div className="rf-replay__group">
            <button ref={backRef} type="button" className="rf-btn rf-btn--quiet" data-nav onClick={closeReplay}>
              <Icon name="back" className="rf-btn__icon" />
              Results
            </button>
            <button
              type="button"
              className="rf-btn"
              data-nav
              disabled={!ready || recording || st.phase === 'ended'}
              onClick={togglePause}
              aria-label={st.paused ? 'Play' : 'Pause'}
            >
              <Icon name={st.paused ? 'play' : 'pause'} className="rf-btn__icon" />
            </button>
            <button type="button" className="rf-btn" data-nav disabled={seeking || recording} onClick={() => replayControl.restart()}>
              <Icon name="restart" className="rf-btn__icon" />
              Again
            </button>
          </div>

          <div className="rf-replay__group rf-replay__group--opts">
            <div className="rf-segmented" role="radiogroup" aria-label="Camera">
              {CAMERAS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  role="radio"
                  aria-checked={st.camera === c.value}
                  className="rf-segmented__opt"
                  data-nav
                  onClick={() => st.set({ camera: c.value })}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <div className="rf-segmented" role="radiogroup" aria-label="Speed">
              {SPEEDS.map((x) => (
                <button
                  key={x.value}
                  type="button"
                  role="radio"
                  aria-checked={st.speed === x.value}
                  className="rf-segmented__opt rf-replay__speed"
                  data-nav
                  onClick={() => st.set({ speed: x.value })}
                >
                  {x.label}
                </button>
              ))}
            </div>
            <label className="rf-replay__auto">
              <span>Auto slow-mo</span>
              <button
                type="button"
                role="switch"
                aria-checked={st.autoSlowmo}
                className="rf-switch"
                data-nav
                onClick={() => st.set({ autoSlowmo: !st.autoSlowmo })}
              >
                <span className="rf-switch__knob" />
              </button>
            </label>
          </div>

          <div className="rf-replay__group rf-replay__group--export">
            {st.exportSupported ? (
              <>
                {st.exportPhase === 'done' && st.exportUrl && (
                  <a className="rf-btn" data-nav href={st.exportUrl} download={st.exportName}>
                    <Icon name="download" className="rf-btn__icon" />
                    Save again
                  </a>
                )}
                <button
                  type="button"
                  className="rf-btn rf-btn--primary"
                  data-nav
                  disabled={seeking || recording}
                  onClick={() => replayControl.exportClip()}
                >
                  <Icon name="download" className="rf-btn__icon" />
                  {recording ? `Recording ${formatInt(st.progress * 100)}%` : st.exportPhase === 'done' ? 'Export again' : 'Export last 10 s'}
                </button>
              </>
            ) : (
              <span className="rf-replay__note">Video export needs a browser with MediaRecorder (Chrome, Edge, Firefox, Safari 14.1+).</span>
            )}
          </div>
        </div>
        {st.exportPhase === 'error' && <p className="rf-replay__note rf-replay__note--err">Export failed: {st.exportError}</p>}
        {st.exportPhase === 'done' && <p className="rf-replay__note">Saved {st.exportName}. The video has no sound.</p>}
      </footer>
    </div>
  );
}
