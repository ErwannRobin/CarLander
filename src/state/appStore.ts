/**
 * App flow state machine (screens + overlays). Not persisted.
 *
 *   boot ──boot()──► title ──goLevelSelect()──► levelSelect ──startLevel(id)──► playing
 *                      ▲                              ▲                          │
 *                      └───────── goTitle() ──────────┴──── goLevelSelect() ─────┘
 *
 * While `screen === 'playing'` an overlay may be shown: pause | settings | complete.
 * Settings can also open over the title / level select; `settingsFrom` remembers which
 * overlay to return to on close.
 *
 * Integration contract:
 *  - call `boot()` once the game is ready (physics initialised, first frame rendered);
 *  - (re)create / reset the sim whenever `levelId` or `runNonce` changes while playing
 *    (`startLevel` / `restart` clear the HUD store first, then notify subscribers);
 *  - pause the sim while `selectSimPaused(state)`;
 *  - on the sim's `levelComplete` event call `showComplete(result)` (it records progress;
 *    the overlay only opens while playing).
 */
import { create } from 'zustand';
import type { LevelId, LevelResult } from '@/game/types';
import { resetHud } from './hudStore';
import { useProgressStore, type RecordOutcome } from './progressStore';

export type Screen = 'boot' | 'title' | 'levelSelect' | 'playing';
export type Overlay = 'none' | 'pause' | 'settings' | 'complete';

export interface AppState {
  screen: Screen;
  overlay: Overlay;
  levelId: LevelId;
  /** Incremented on every (re)start of a run — integration resets the sim when it changes. */
  runNonce: number;
  lastResult: LevelResult | null;
  /** What recording `lastResult` into progress produced (new-best flags, unlocks). */
  lastRecord: RecordOutcome | null;
  /** Overlay to return to when the settings panel closes. */
  settingsFrom: Exclude<Overlay, 'settings'>;

  boot(): void;
  goTitle(): void;
  goLevelSelect(): void;
  startLevel(id: LevelId): void;
  restart(): void;
  pause(): void;
  resume(): void;
  togglePause(): void;
  openSettings(): void;
  closeSettings(): void;
  showComplete(result: LevelResult): void;
  nextLevel(): void;
}

export const useAppStore = create<AppState>()((set, get) => ({
  screen: 'boot',
  overlay: 'none',
  levelId: 1,
  runNonce: 0,
  lastResult: null,
  lastRecord: null,
  settingsFrom: 'none',

  boot: () => {
    if (get().screen === 'boot') set({ screen: 'title', overlay: 'none' });
  },

  goTitle: () => set({ screen: 'title', overlay: 'none', settingsFrom: 'none' }),

  goLevelSelect: () => set({ screen: 'levelSelect', overlay: 'none', settingsFrom: 'none' }),

  startLevel: (id) => {
    // Clear the previous run's HUD first: subscribers reacting to the new runNonce (the runner)
    // may publish fresh data synchronously, and must not be overwritten by a later reset.
    resetHud();
    set((s) => ({
      screen: 'playing',
      overlay: 'none',
      settingsFrom: 'none',
      levelId: id,
      runNonce: s.runNonce + 1,
      lastResult: null,
      lastRecord: null,
    }));
  },

  restart: () => {
    if (get().screen !== 'playing') return;
    resetHud();
    set((s) => ({ overlay: 'none', settingsFrom: 'none', runNonce: s.runNonce + 1, lastResult: null, lastRecord: null }));
  },

  pause: () => {
    const s = get();
    if (s.screen === 'playing' && s.overlay === 'none') set({ overlay: 'pause' });
  },

  resume: () => {
    if (get().overlay === 'pause') set({ overlay: 'none' });
  },

  togglePause: () => {
    const s = get();
    if (s.screen !== 'playing') return;
    if (s.overlay === 'none') s.pause();
    else if (s.overlay === 'pause') s.resume();
    else if (s.overlay === 'settings') s.closeSettings();
  },

  openSettings: () => {
    const s = get();
    if (s.overlay === 'settings') return;
    set({ settingsFrom: s.overlay, overlay: 'settings' });
  },

  closeSettings: () => {
    const s = get();
    if (s.overlay !== 'settings') return;
    set({ overlay: s.settingsFrom, settingsFrom: 'none' });
  },

  showComplete: (result) => {
    const lastRecord = useProgressStore.getState().recordResult(result);
    // A completion that lands after the player left gameplay still counts, but must not put
    // an overlay over the menus (it would make them inert with nothing to dismiss).
    if (get().screen !== 'playing') {
      set({ lastResult: result, lastRecord });
      return;
    }
    set({ overlay: 'complete', settingsFrom: 'none', lastResult: result, lastRecord });
  },

  nextLevel: () => {
    const { levelId } = get();
    const next: LevelId | null = levelId < 4 ? ((levelId + 1) as LevelId) : null;
    if (next && useProgressStore.getState().levels[next].unlocked) get().startLevel(next);
    else get().goLevelSelect();
  },
}));

/** Gameplay input should drive the car (no menu or overlay on top). */
export const selectInputEnabled = (s: AppState): boolean => s.screen === 'playing' && s.overlay === 'none';

/** The simulation should be frozen (pause menu or settings opened from it). */
export const selectSimPaused = (s: AppState): boolean =>
  s.screen === 'playing' && (s.overlay === 'pause' || s.overlay === 'settings');
