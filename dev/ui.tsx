/**
 * UI sandbox: dev/ui.html?screen=title|levels|hud|pause|settings|complete|crash|touch|boot|app
 *
 * Each screen renders over a static atmospheric gradient (no 3D) with mock data. A MockSim is
 * stepped by requestAnimationFrame and feeds publishHud (~30 Hz) and runtime.events.
 *
 * Extra params:
 *   sky=title|morning|canyon|night   backdrop (default depends on the screen)
 *   t=<seconds>                      freeze the mock timeline (deterministic screenshots)
 *   prompt=0                         disable the mock center prompt
 *   progress=fresh|mid|done          mock level progress (levels screen)
 *   level=1|2|3                      level for hud/pause/complete
 *   persist=1                        keep the (sandbox-keyed) persisted settings/progress across
 *                                    reloads: no settings reset, no mock progress
 *   combo=1                          a second trick in the jump (trick feed + combo multiplier)
 *   mock=0                           no mock sim: tests drive publishHud / runtime.events themselves
 *   quality=low|medium|high          graphics quality setting (low = no backdrop blur)
 */
import { createRoot } from 'react-dom/client';
import { useEffect, useRef, type CSSProperties } from 'react';
import { Vector3 } from 'three';
import '@/styles/base.css';
import { runtime } from '@/game/runtime';
import type { LevelId, LevelProgress, LevelResult, SimSnapshot } from '@/game/types';
import { MockSim } from '@/dev/mockRuntime';
import { useAppStore } from '@/state/appStore';
import { useProgressStore } from '@/state/progressStore';
import { useSettingsStore } from '@/state/settingsStore';
import { publishHud, useHudStore } from '@/state/hudStore';
import { useInputManager } from '@/input';
import { Screens } from '@/ui';

type ScreenParam = 'title' | 'levels' | 'hud' | 'pause' | 'settings' | 'complete' | 'crash' | 'touch' | 'boot' | 'app';
type Sky = 'title' | 'morning' | 'canyon' | 'night';

const params = new URLSearchParams(location.search);
const screen = (params.get('screen') ?? 'title') as ScreenParam;
const freezeParam = params.get('t') ?? (screen === 'crash' ? '12.2' : null);
const freezeAt = freezeParam !== null ? Number(freezeParam) : undefined;
const level = Number(params.get('level') ?? (screen === 'complete' ? 2 : 1)) as LevelId;
const DEFAULT_SKY: Record<ScreenParam, Sky> = {
  title: 'title',
  levels: 'title',
  hud: 'morning',
  pause: 'canyon',
  settings: 'canyon',
  complete: 'canyon',
  crash: 'morning',
  touch: 'morning',
  boot: 'title',
  app: 'title',
};
const sky = (params.get('sky') ?? DEFAULT_SKY[screen]) as Sky;
const withCombo = params.get('combo') === '1';
const mockOn = params.get('mock') !== '0';
const qualityParam = params.get('quality');

/* ------------------------------------------------------------------ */
/* Sandbox state isolation + mock data                                 */
/* ------------------------------------------------------------------ */

const persistMode = params.get('persist') === '1';

// The sandbox never touches the game's real save keys.
useProgressStore.persist.setOptions({ name: 'roadster-flight.progress.sandbox' });
useSettingsStore.persist.setOptions({ name: 'roadster-flight.settings.sandbox' });
if (persistMode) {
  // Load what a previous sandbox session saved (synchronous storage → applied before render).
  void useSettingsStore.persist.rehydrate();
  void useProgressStore.persist.rehydrate();
} else {
  useSettingsStore.getState().resetAll();
}
if (qualityParam === 'low' || qualityParam === 'medium' || qualityParam === 'high') {
  useSettingsStore.getState().setQuality(qualityParam);
}

function lp(p: Partial<LevelProgress>): LevelProgress {
  return { unlocked: false, completed: false, bestScore: 0, bestMedal: 'none', bestLanding: null, bestTime: null, attempts: 0, ...p };
}

function mockProgress(kind: string): Record<LevelId, LevelProgress> {
  if (kind === 'fresh') return { 1: lp({ unlocked: true }), 2: lp({}), 3: lp({}) };
  if (kind === 'done')
    return {
      1: lp({ unlocked: true, completed: true, bestScore: 18450, bestMedal: 'gold', attempts: 4, bestTime: 41.2, bestLanding: { quality: 'perfect', angleDeg: 2.4, impactSpeed: 5.1, points: 3200 } }),
      2: lp({ unlocked: true, completed: true, bestScore: 42760, bestMedal: 'silver', attempts: 11, bestTime: 72.5, bestLanding: { quality: 'clean', angleDeg: 11.8, impactSpeed: 9.4, points: 5200 } }),
      3: lp({ unlocked: true, completed: true, bestScore: 61200, bestMedal: 'bronze', attempts: 23, bestTime: 96.1, bestLanding: { quality: 'hard', angleDeg: 31.5, impactSpeed: 17.2, points: 1800 } }),
    };
  return {
    1: lp({ unlocked: true, completed: true, bestScore: 18450, bestMedal: 'gold', attempts: 4, bestTime: 41.2, bestLanding: { quality: 'perfect', angleDeg: 2.4, impactSpeed: 5.1, points: 3200 } }),
    2: lp({ unlocked: true, attempts: 2 }),
    3: lp({}),
  };
}

if (!persistMode) {
  useProgressStore.setState({ levels: mockProgress(params.get('progress') ?? (screen === 'complete' ? 'midcomplete' : 'mid')) });
}
if (screen === 'complete' && !persistMode) {
  // previous records lower than the mock result → NEW BEST badges
  const levels = useProgressStore.getState().levels;
  useProgressStore.setState({
    levels: { ...levels, 2: lp({ unlocked: true, completed: true, bestScore: 31200, bestMedal: 'silver', attempts: 6, bestLanding: { quality: 'clean', angleDeg: 14.2, impactSpeed: 10.1, points: 2600 } }) },
  });
}

function mockResult(levelId: LevelId): LevelResult {
  const landing = {
    quality: 'perfect' as const,
    angleDeg: 3.4,
    impactSpeed: 5.8,
    driftDeg: 2.1,
    wheelsDown: 4,
    airTime: 4.2,
    distance: 168,
    maxHeight: 22.4,
    tricks: [
      { kind: 'backflip' as const, label: 'DOUBLE BACKFLIP', count: 2, points: 900 },
      { kind: 'spin' as const, label: '360 SPIN', count: 1, points: 400 },
    ],
    basePoints: 3200,
    multiplier: 3,
    points: 9600,
    inTarget: true,
    position: new Vector3(),
  };
  return {
    levelId,
    score: 48650,
    time: 74.32,
    medal: 'gold',
    finalLanding: landing,
    bestLanding: landing,
    breakdown: [
      { label: 'Jumps', value: '3 landed', points: 12400 },
      { label: 'Tricks', value: 'Double backflip, 360 spin', points: 9800 },
      { label: 'Final landing', value: 'Perfect', points: 9600 },
      { label: 'Chain bonus', value: '×1.75', points: 10000 },
      { label: 'Time bonus', value: '1:14.32', points: 6850 },
    ],
    stats: { maxSpeedKmh: 276, maxAirTime: 4.2, longestJump: 168, tricks: 3, invertedDistance: levelId === 3 ? 112 : 0 },
  };
}

/* ------------------------------------------------------------------ */
/* Mock sim driver                                                     */
/* ------------------------------------------------------------------ */

const OBJECTIVES = [
  { title: 'Build speed', text: 'Accelerate down the runway toward the kicker.', hints: [{ keys: ['W'], label: 'Accelerate', actions: ['accelerate' as const] }] },
  {
    title: 'Clear the gap',
    text: 'Fire the thrusters at the lip and carry across the gap.',
    hints: [
      { keys: ['SPACE'], label: 'Thrusters', actions: ['boost' as const] },
      { keys: ['W', 'S'], label: 'Pitch', actions: ['accelerate' as const, 'brake' as const] },
    ],
  },
  {
    title: 'Land in the target',
    text: 'Match the deck angle and settle inside the rings.',
    hints: [{ keys: ['SHIFT'], label: 'Stabilize', actions: ['stabilize' as const] }],
  },
];

function decorate(s: SimSnapshot, t: number, withPrompt: boolean): void {
  const idx = t < 4 ? 0 : t < 7 ? 1 : 2;
  const o = OBJECTIVES[idx];
  if (s.objective.id !== `obj-${idx}`) {
    s.objective = { index: idx, total: 5, id: `obj-${idx}`, title: o.title, text: o.text, hints: o.hints, complete: false };
  }
  s.levelId = level;
  s.vehicle.vacuum.available = level === 3 || screen === 'hud' || screen === 'touch';
  if (withPrompt && t >= 4.0 && t < 4.9) {
    if (!s.prompt) s.prompt = { id: 'thrust', text: 'HOLD SPACE — FIRE THRUSTERS', hint: { keys: ['SPACE'], label: 'Thrusters', actions: ['boost'] }, tone: 'action' };
  } else if (withPrompt && t >= 8.0 && t < 8.6) {
    if (!s.prompt || s.prompt.id !== 'vac') s.prompt = { id: 'vac', text: 'HOLD ENTER — ENGAGE VACUUM', hint: { keys: ['ENTER'], label: 'Vacuum', actions: ['vacuum'] }, tone: 'info' };
  } else {
    s.prompt = null;
  }
  s.score.chain = t > 7 ? 2 : 0;
  s.score.comboMultiplier = t > 7 ? 1.25 : 1;
  if (withCombo && t >= 6.2 && t < 7) {
    s.air.tricks = [
      { kind: 'backflip', label: 'BACKFLIP', count: 1, points: 800 },
      { kind: 'spin', label: '360 SPIN', count: 1, points: 400 },
    ];
    s.air.pendingPoints = 2100;
  }
}

function MockDriver() {
  useEffect(() => {
    const sim = new MockSim({ freezeAt });
    const withPrompt = params.get('prompt') !== '0';
    let raf = 0;
    let last = performance.now();
    let acc = 1;
    let simT = freezeAt ?? 0;
    let comboFired = false;
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      simT = freezeAt ?? (simT + dt) % 12.5;
      const events = sim.update(dt);
      decorate(sim.snapshot, simT, withPrompt);
      if (withCombo && !comboFired && events.some((e) => e.type === 'trick')) {
        comboFired = true;
        events.push({ type: 'trick', trick: { kind: 'spin', label: '360 SPIN', count: 1, points: 400 } });
      }
      if (events.some((e) => e.type === 'reset')) comboFired = false;
      runtime.frame.snapshot = sim.snapshot;
      runtime.frame.dt = dt;
      runtime.frame.simDt = dt;
      runtime.frame.time += dt;
      for (const e of events) runtime.events.emit(e);
      acc += dt;
      if (acc >= 1 / 30) {
        acc = 0;
        publishHud(sim.snapshot);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return null;
}

/* ------------------------------------------------------------------ */
/* Backdrop                                                            */
/* ------------------------------------------------------------------ */

const SKIES: Record<Sky, string> = {
  title:
    'radial-gradient(60% 55% at 64% 58%, rgba(214,196,170,0.34), transparent 70%),' +
    'radial-gradient(120% 60% at 50% 110%, #c9c3b8 0%, rgba(150,150,150,0.0) 60%),' +
    'linear-gradient(180deg, #1b2733 0%, #3c4f61 38%, #8b8f91 66%, #b9b2a6 100%)',
  morning:
    'radial-gradient(40% 30% at 70% 40%, rgba(255,246,220,0.9), transparent 70%),' +
    'linear-gradient(180deg, #5f93c2 0%, #9cc1dc 35%, #e8ecea 62%, #f4efe4 70%, #dfe5ea 100%)',
  canyon:
    'radial-gradient(45% 35% at 30% 55%, rgba(255,190,110,0.85), transparent 70%),' +
    'linear-gradient(180deg, #2c3550 0%, #6b5a6a 30%, #d88f52 58%, #8c5a3c 75%, #3b2a24 100%)',
  night: 'radial-gradient(50% 40% at 50% 20%, rgba(90,110,160,0.25), transparent 70%), linear-gradient(180deg, #04060b 0%, #0d1220 55%, #1b2130 100%)',
};

function Backdrop() {
  const style: CSSProperties = { position: 'fixed', inset: 0, background: SKIES[sky] };
  return (
    <div style={style}>
      {(screen === 'title' || screen === 'app') && (
        // where the live car preview will sit (composition check only)
        <div
          style={{
            position: 'absolute',
            left: '52%',
            top: '50%',
            width: '34%',
            height: '18%',
            borderRadius: '50%',
            background: 'radial-gradient(closest-side, rgba(20,22,25,0.55), rgba(20,22,25,0.0))',
            filter: 'blur(6px)',
          }}
        />
      )}
      {(sky === 'morning' || sky === 'canyon') && (
        // horizon line + cloud sea suggestion
        <div style={{ position: 'absolute', left: 0, right: 0, top: '66%', bottom: 0, background: 'linear-gradient(180deg, rgba(255,255,255,0.35), rgba(255,255,255,0.0) 30%)' }} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Screen selection                                                    */
/* ------------------------------------------------------------------ */

function applyAppState(): void {
  const app = useAppStore.getState();
  switch (screen) {
    case 'boot':
      break;
    case 'title':
    case 'app':
      app.boot();
      break;
    case 'levels':
      app.boot();
      app.goLevelSelect();
      break;
    case 'pause':
      app.startLevel(level);
      app.pause();
      break;
    case 'settings':
      app.startLevel(level);
      app.pause();
      app.openSettings();
      break;
    case 'complete':
      app.startLevel(level);
      app.showComplete(mockResult(level));
      break;
    default:
      app.startLevel(level);
  }
}

/** Real input wiring (as the game will do it) + test hooks on window.__rf. */
function InputHarness() {
  const input = useInputManager();
  useEffect(() => {
    (window as unknown as { __rf: Record<string, unknown> }).__rf = {
      app: useAppStore,
      settings: useSettingsStore,
      progress: useProgressStore,
      hud: useHudStore,
      publishHud,
      runtime,
      input,
      mockResult,
    };
  }, [input]);
  return null;
}

function Sandbox() {
  const ready = useRef(false);
  useEffect(() => {
    if (ready.current) return;
    ready.current = true;
    document.fonts.ready.then(() => {
      requestAnimationFrame(() => requestAnimationFrame(() => ((window as unknown as { __shotReady: boolean }).__shotReady = true)));
    });
  }, []);

  return (
    <>
      <Backdrop />
      <Screens forceTouch={screen === 'touch'} />
      {mockOn && <MockDriver />}
      <InputHarness />
    </>
  );
}

applyAppState();
createRoot(document.getElementById('root')!).render(<Sandbox />);
