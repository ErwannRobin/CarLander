/**
 * In-game HUD. Reads display data from useHudStore (fed by publishHud at ~30 Hz) and
 * subscribes to runtime.events for momentary feedback. Secondary to the scene: everything
 * lives at the edges, the centre is reserved for prompts and landing feedback.
 *
 *   ┌ objective ─────────────────────────────── controls · restart · pause ┐
 *   │                                                              score │
 *   │                    [ prompt ]                                       │
 *   │                 PERFECT LANDING                        trick feed  │
 *   │                                                                     │
 *   └ speed/thrust · vacuum ──── altitude · (attitude) · distance ─ guide ┘
 */
import { useMemo, useState } from 'react';
import { keyLabel } from '@/input/keyNames';
import { useAppStore } from '@/state/appStore';
import { actionForCode, useSettingsStore } from '@/state/settingsStore';
import { isShortcutChord, useKeyDown, useKeyLabelsVersion } from '../hooks';
import { useTouchUiActive } from '../touchUi';
import { CenterPrompt } from './CenterPrompt';
import { FlightStrip } from './FlightStrip';
import { LandingBanner, TrickFeed } from './Feed';
import { ControlGuide, HudButtons, ObjectivePanel, ScoreReadout } from './HudPanels';
import { SpeedCluster } from './SpeedCluster';
import '../styles/tokens.css';
import '../styles/components.css';
import '../styles/hud.css';

/** Physical key (KeyboardEvent.code) that toggles the control guide. */
const GUIDE_KEY = 'KeyH';

export function Hud() {
  const overlay = useAppStore((s) => s.overlay);
  const bindings = useSettingsStore((s) => s.bindings);
  const touch = useTouchUiActive();
  const [guideOpen, setGuideOpen] = useState(false);

  const hidden = overlay === 'complete';
  const interactive = overlay === 'none';
  // The guide toggles on the physical H key unless the player bound it to a game action.
  const hIsGameKey = useMemo(() => actionForCode(bindings, GUIDE_KEY) !== null, [bindings]);
  useKeyLabelsVersion();
  const guideKey = hIsGameKey ? null : keyLabel(GUIDE_KEY);

  useKeyDown(
    (e) => {
      if (e.code !== GUIDE_KEY || e.repeat || hIsGameKey || isShortcutChord(e)) return;
      setGuideOpen((o) => !o);
    },
    { enabled: interactive },
  );

  return (
    <div
      className="rf-layer rf-hud"
      data-hidden={hidden || undefined}
      data-touch={touch || undefined}
      aria-hidden={!interactive || undefined}
      inert={!interactive || undefined}
    >
      <div className="rf-hud__tl">
        <ObjectivePanel />
      </div>
      <div className="rf-hud__tr">
        <HudButtons guideOpen={guideOpen} guideKey={guideKey} onToggleGuide={() => setGuideOpen((o) => !o)} />
        <ScoreReadout />
      </div>
      <TrickFeed />
      <CenterPrompt />
      <LandingBanner />
      <SpeedCluster />
      <FlightStrip />
      {guideOpen && (
        <div className="rf-hud__br">
          <ControlGuide guideKey={guideKey} onClose={() => setGuideOpen(false)} />
        </div>
      )}
    </div>
  );
}
