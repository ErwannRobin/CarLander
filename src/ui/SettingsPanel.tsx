/**
 * Settings: audio (master / music / effects, mute), graphics quality (+ fullscreen),
 * gameplay assists, and key remapping with press-a-key capture.
 *
 * Remapping: click a key slot (or focus it and press Enter), then press the new key.
 * Esc cancels, Backspace / Delete clears the slot. A key drives one action only — if it was
 * bound elsewhere it moves here and the affected row says so.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ControlAction, QualityLevel } from '@/game/types';
import { ACTION_INFO, keyLabel } from '@/input/keyNames';
import { useAppStore } from '@/state/appStore';
import { BINDING_SLOTS, CONTROL_ACTIONS, useSettingsStore } from '@/state/settingsStore';
import { Segmented, Slider, Switch } from './components/Controls';
import { Icon } from './components/Icon';
import { useAutoFocus, useKeyDown, useKeyLabelsVersion, useRepeatActivationGuard } from './hooks';
import './styles/tokens.css';
import './styles/components.css';
import './styles/overlays.css';

const QUALITY_OPTIONS: ReadonlyArray<{ value: QualityLevel; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

const QUALITY_NOTE: Record<QualityLevel, string> = {
  low: 'For older devices: no shadows, lighter effects.',
  medium: 'Balanced: soft shadows and bloom.',
  high: 'Full quality: ambient occlusion and sharp shadows.',
};

/** Keys that can be bound on their own even though they set a modifier flag. */
const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight']);
/** Keys that can never be game keys. */
const RESERVED_CODES = new Set(['MetaLeft', 'MetaRight', 'OSLeft', 'OSRight']);

interface Slot {
  action: ControlAction;
  index: number;
}

interface Notice {
  action: ControlAction;
  text: string;
}

/* ------------------------------------------------------------------ */
/* Fullscreen (browser state, not persisted)                           */
/* ------------------------------------------------------------------ */

function subscribeFullscreen(cb: () => void) {
  document.addEventListener('fullscreenchange', cb);
  return () => document.removeEventListener('fullscreenchange', cb);
}
function useFullscreen(): [boolean, (on: boolean) => void, boolean] {
  const active = useSyncExternalStore(subscribeFullscreen, () => !!document.fullscreenElement, () => false);
  const supported = typeof document !== 'undefined' && !!document.fullscreenEnabled;
  const set = (on: boolean) => {
    if (on && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    else if (!on && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  };
  return [active, set, supported];
}

/* ------------------------------------------------------------------ */
/* Key binding rows                                                    */
/* ------------------------------------------------------------------ */

function BindingRows() {
  const bindings = useSettingsStore((s) => s.bindings);
  const setBinding = useSettingsStore((s) => s.setBinding);
  const resetBindings = useSettingsStore((s) => s.resetBindings);
  useKeyLabelsVersion();
  const [capture, setCapture] = useState<Slot | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  // Capture the next key press (capture phase: nothing else sees it).
  useEffect(() => {
    if (!capture) return;
    const onKey = (e: KeyboardEvent) => {
      const code = e.code;
      // Browser / OS shortcuts (Cmd+R, Ctrl+Tab…) pass through untouched. A lone Ctrl or Alt
      // can still be bound: it arrives as its own key code.
      if ((e.metaKey || e.ctrlKey || e.altKey) && !MODIFIER_CODES.has(code)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat || !code) return;
      if (RESERVED_CODES.has(code)) {
        // ⌘ / Win can't be a game key: macOS drops the key-up of anything released while it is held.
        setNotice({ action: capture.action, text: `${keyLabel(code)} is reserved by the system` });
        return;
      }
      if (code === 'Escape') {
        setCapture(null);
        return;
      }
      if (code === 'Backspace' || code === 'Delete') {
        setBinding(capture.action, capture.index, null);
        setNotice(null);
        setCapture(null);
        return;
      }
      const { displaced } = setBinding(capture.action, capture.index, code);
      setNotice(
        displaced ? { action: displaced.action, text: `${keyLabel(code)} now drives ${ACTION_INFO[capture.action].name.toLowerCase()}` } : null,
      );
      setCapture(null);
    };
    // Clicking or moving focus elsewhere (mouse, gamepad D-pad) cancels the capture.
    const outside = (e: Event) => {
      if (!(e.target instanceof Element) || !e.target.closest('[data-capturing]')) setCapture(null);
    };
    const onBlur = () => setCapture(null);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('focusin', outside);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('focusin', outside);
      window.removeEventListener('blur', onBlur);
    };
  }, [capture, setBinding]);

  return (
    <section className="rf-settings__section rf-settings__section--controls" aria-labelledby="rf-set-controls">
      <header className="rf-settings__section-head">
        <h2 id="rf-set-controls" className="rf-settings__heading">
          Controls
        </h2>
        <button
          type="button"
          className="rf-btn rf-btn--quiet rf-settings__reset"
          onClick={() => {
            resetBindings();
            setNotice(null);
            setCapture(null);
          }}
        >
          <Icon name="restart" className="rf-btn__icon" />
          Reset to defaults
        </button>
      </header>
      <div className="rf-binds" role="table" aria-label="Key bindings">
        {CONTROL_ACTIONS.map((action) => {
          const codes = bindings[action] ?? [];
          const info = ACTION_INFO[action];
          const conflict = notice?.action === action;
          return (
            <div
              key={action}
              className="rf-bind"
              role="row"
              data-conflict={conflict || undefined}
              data-unbound={codes.length === 0 || undefined}
            >
              <div className="rf-bind__name" role="rowheader">
                <span>{info.name}</span>
                {conflict ? (
                  <span className="rf-bind__notice">{notice.text}</span>
                ) : codes.length === 0 ? (
                  <span className="rf-bind__notice">No key: choose one</span>
                ) : (
                  info.detail && <span className="rf-bind__detail">{info.detail}</span>
                )}
              </div>
              <div className="rf-bind__slots" role="cell">
                {Array.from({ length: BINDING_SLOTS }, (_, i) => {
                  const code = codes[i];
                  // Bindings stay compact: a click past the last key targets the next free slot.
                  const isTarget = capture?.action === action && capture.index === i;
                  return (
                    <button
                      key={i}
                      type="button"
                      className="rf-bind__slot"
                      data-capturing={isTarget || undefined}
                      data-empty={!code || undefined}
                      aria-label={
                        isTarget
                          ? `Press a key for ${info.name}`
                          : code
                            ? `${info.name}: ${keyLabel(code)}. Change`
                            : `${info.name}: add a key`
                      }
                      onClick={() => setCapture({ action, index: Math.min(i, codes.length) })}
                    >
                      {isTarget ? 'Press a key' : code ? keyLabel(code) : '+'}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <p className="rf-settings__note">
        {capture ? 'Press the new key. Esc cancels, Backspace clears the slot.' : 'Select a key to change it. Each key drives one action.'}
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function SettingsPanel() {
  const closeSettings = useAppStore((s) => s.closeSettings);
  const masterVolume = useSettingsStore((s) => s.masterVolume);
  const musicVolume = useSettingsStore((s) => s.musicVolume);
  const sfxVolume = useSettingsStore((s) => s.sfxVolume);
  const muted = useSettingsStore((s) => s.muted);
  const quality = useSettingsStore((s) => s.quality);
  const cameraShake = useSettingsStore((s) => s.cameraShake);
  const flightAssist = useSettingsStore((s) => s.flightAssist);
  const showTrajectory = useSettingsStore((s) => s.showTrajectory);
  const actions = useSettingsStore.getState();
  const [fullscreen, setFullscreen, fullscreenSupported] = useFullscreen();

  const doneRef = useRef<HTMLButtonElement>(null);
  useAutoFocus(doneRef);
  useRepeatActivationGuard();
  useKeyDown((e) => {
    // Key capture (capture phase) stops propagation, so this only sees "free" presses.
    if (e.key === 'Escape' && !e.repeat) {
      e.preventDefault();
      closeSettings();
    }
  });

  return (
    <div className="rf-layer rf-overlay rf-settings" role="dialog" aria-modal="true" aria-labelledby="rf-settings-title">
      <div className="rf-settings__scrim" aria-hidden="true" />
      <div className="rf-settings__sheet">
        <header className="rf-settings__head">
          <h1 id="rf-settings-title" className="rf-settings__title">
            Settings
          </h1>
          <button ref={doneRef} type="button" className="rf-btn rf-settings__done" onClick={closeSettings}>
            Done
          </button>
        </header>

        <div className="rf-settings__body">
          <div className="rf-settings__col">
            <section className="rf-settings__section" aria-labelledby="rf-set-audio">
              <h2 id="rf-set-audio" className="rf-settings__heading">
                Audio
              </h2>
              <Slider label="Master" value={masterVolume} dimmed={muted} onChange={(v) => actions.setVolume('master', v)} />
              <Slider label="Music" value={musicVolume} dimmed={muted} onChange={(v) => actions.setVolume('music', v)} />
              <Slider label="Effects" value={sfxVolume} dimmed={muted} onChange={(v) => actions.setVolume('sfx', v)} />
              <Switch label="Mute all sound" checked={muted} onChange={actions.setMuted} />
            </section>

            <section className="rf-settings__section" aria-labelledby="rf-set-graphics">
              <h2 id="rf-set-graphics" className="rf-settings__heading">
                Graphics
              </h2>
              <Segmented label="Quality" value={quality} options={QUALITY_OPTIONS} onChange={actions.setQuality} />
              <p className="rf-settings__note rf-settings__note--inline">{QUALITY_NOTE[quality]}</p>
              {fullscreenSupported && <Switch label="Fullscreen" checked={fullscreen} onChange={setFullscreen} />}
            </section>

            <section className="rf-settings__section" aria-labelledby="rf-set-gameplay">
              <h2 id="rf-set-gameplay" className="rf-settings__heading">
                Gameplay
              </h2>
              <Switch label="Camera shake" detail="On landings and impacts" checked={cameraShake} onChange={actions.setCameraShake} />
              <Switch
                label="Flight assist"
                detail="Gently levels the car when you are not rotating"
                checked={flightAssist}
                onChange={actions.setFlightAssist}
              />
              <Switch
                label="Trajectory preview"
                detail="Shows the predicted flight path and landing spot"
                checked={showTrajectory}
                onChange={actions.setShowTrajectory}
              />
            </section>

            <section className="rf-settings__section" aria-labelledby="rf-set-gamepad">
              <h2 id="rf-set-gamepad" className="rf-settings__heading">
                Gamepad
              </h2>
              <p className="rf-settings__note rf-settings__note--inline">
                {/* non-breaking spaces keep each button with its verb */}
                Left stick steers and pitches, RT&nbsp;and&nbsp;LT drive, A&nbsp;thrusts, RB&nbsp;vacuum, LB&nbsp;stabilize,
                X&nbsp;and&nbsp;Y roll. Start&nbsp;pauses, Back&nbsp;restarts. Menus: D-pad, A&nbsp;and&nbsp;B.
              </p>
            </section>
          </div>

          <div className="rf-settings__col">
            <BindingRows />
          </div>
        </div>
      </div>
    </div>
  );
}
