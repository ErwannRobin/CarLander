/**
 * Top-level UI switch: renders the right UI for the app state.
 *
 *   boot        → <BootScreen/>
 *   title       → <TitleScreen/>
 *   levelSelect → <LevelSelect/>
 *   playing     → <Hud/> + <CrashBanner/> + <TouchControls/> + pause / complete overlays
 *   settings overlay (any screen) → <SettingsPanel/>
 *
 * Also drives menu navigation from a gamepad (<GamepadMenuNav/>) whenever a menu is up.
 * Render it once, above the canvas. `data-quality="low"` disables backdrop blur.
 */
import { useEffect } from 'react';
import { useAppStore } from '@/state/appStore';
import { resetHud } from '@/state/hudStore';
import { useSettingsStore } from '@/state/settingsStore';
import { BootScreen } from './BootScreen';
import { CrashBanner } from './CrashBanner';
import { GamepadMenuNav } from './GamepadMenuNav';
import { Hud } from './hud/Hud';
import { LevelComplete } from './LevelComplete';
import { LevelSelect } from './LevelSelect';
import { PauseMenu } from './PauseMenu';
import { SettingsPanel } from './SettingsPanel';
import { TitleScreen } from './TitleScreen';
import { TouchControls } from './TouchControls';
import './styles/tokens.css';

export interface ScreensProps {
  /** Boot screen progress 0..1 (indeterminate when omitted). */
  bootProgress?: number;
  bootMessage?: string;
  /** Crash auto-restart delay used by the crash banner's progress line (ms, default 1700 = GameRunner). */
  autoRestartMs?: number;
  /** Force touch controls on non-touch devices (testing). */
  forceTouch?: boolean;
}

export function Screens({ bootProgress, bootMessage, autoRestartMs, forceTouch }: ScreensProps) {
  const screen = useAppStore((s) => s.screen);
  const overlay = useAppStore((s) => s.overlay);
  const quality = useSettingsStore((s) => s.quality);

  // Stale HUD data must not flash when the next run starts.
  useEffect(() => {
    if (screen !== 'playing') resetHud();
  }, [screen]);

  return (
    <div className="rf-root" data-screen={screen} data-overlay={overlay} data-quality={quality}>
      {screen === 'boot' && <BootScreen progress={bootProgress} message={bootMessage} />}
      {screen === 'title' && <TitleScreen />}
      {screen === 'levelSelect' && <LevelSelect />}
      {screen === 'playing' && (
        <>
          <Hud />
          {overlay !== 'complete' && <CrashBanner autoRestartMs={autoRestartMs} />}
          <TouchControls force={forceTouch} />
          {overlay === 'pause' && <PauseMenu />}
          {overlay === 'complete' && <LevelComplete />}
        </>
      )}
      {overlay === 'settings' && <SettingsPanel />}
      <GamepadMenuNav />
    </div>
  );
}
