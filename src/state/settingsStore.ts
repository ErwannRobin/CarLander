/**
 * User settings (audio, graphics, gameplay assists, key bindings) — persisted.
 *
 * Shape follows `Settings` in src/game/types.ts. Bindings are KeyboardEvent.code values
 * (layout-independent physical keys), at most BINDING_SLOTS per action.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ControlAction, QualityLevel, Settings } from '@/game/types';
import { asBool, asOneOf, asUnit, createSafeStorage, isRecord } from './storage';

/** Every rebindable action, in display order. */
export const CONTROL_ACTIONS: readonly ControlAction[] = [
  'accelerate',
  'brake',
  'left',
  'right',
  'rollLeft',
  'rollRight',
  'boost',
  'jump',
  'vacuum',
  'stabilize',
  'restart',
  'pause',
];

/** Maximum keys per action (primary + secondary). */
export const BINDING_SLOTS = 2;

export const QUALITY_LEVELS: readonly QualityLevel[] = ['low', 'medium', 'high'];

/** Default key bindings (ARCHITECTURE §12), KeyboardEvent.code values. */
export const DEFAULT_BINDINGS: Readonly<Record<ControlAction, readonly string[]>> = Object.freeze({
  accelerate: Object.freeze(['KeyW', 'ArrowUp']),
  brake: Object.freeze(['KeyS', 'ArrowDown']),
  left: Object.freeze(['KeyA', 'ArrowLeft']),
  right: Object.freeze(['KeyD', 'ArrowRight']),
  rollLeft: Object.freeze(['KeyQ']),
  rollRight: Object.freeze(['KeyE']),
  boost: Object.freeze(['Space']),
  jump: Object.freeze(['KeyF']),
  vacuum: Object.freeze(['Enter']),
  stabilize: Object.freeze(['ShiftLeft', 'ShiftRight']),
  restart: Object.freeze(['KeyR']),
  pause: Object.freeze(['Escape', 'KeyP']),
});

/** Mutable deep copy of the default bindings. */
export function defaultBindings(): Settings['bindings'] {
  const out = {} as Settings['bindings'];
  for (const a of CONTROL_ACTIONS) out[a] = [...DEFAULT_BINDINGS[a]];
  return out;
}

function defaultQuality(): QualityLevel {
  try {
    if (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches) return 'medium';
  } catch {
    /* ignore */
  }
  return 'high';
}

export function defaultSettings(): Settings {
  return {
    masterVolume: 1,
    musicVolume: 0.6,
    sfxVolume: 0.9,
    muted: false,
    quality: defaultQuality(),
    cameraShake: true,
    flightAssist: true,
    showTrajectory: true,
    tiltSteering: true,
    bindings: defaultBindings(),
  };
}

export type VolumeKind = 'master' | 'music' | 'sfx';

/** Result of a binding change: which slot (if any) lost the key because it moved here. */
export interface BindingChange {
  displaced: { action: ControlAction; index: number } | null;
}

export interface SettingsActions {
  setVolume(kind: VolumeKind, v: number): void;
  setMuted(muted: boolean): void;
  setQuality(quality: QualityLevel): void;
  setCameraShake(on: boolean): void;
  setFlightAssist(on: boolean): void;
  setShowTrajectory(on: boolean): void;
  setTiltSteering(on: boolean): void;
  /**
   * Bind `code` to `action` at slot `index` (0 = primary, 1 = secondary).
   * A key can only drive one action: if `code` is bound elsewhere it is removed there
   * (reported as `displaced`). `code = null` clears the slot.
   */
  setBinding(action: ControlAction, index: number, code: string | null): BindingChange;
  resetBindings(): void;
  /** Restore every setting (including bindings) to defaults. */
  resetAll(): void;
}

export type SettingsStore = Settings & SettingsActions;

const VOLUME_KEY: Record<VolumeKind, 'masterVolume' | 'musicVolume' | 'sfxVolume'> = {
  master: 'masterVolume',
  music: 'musicVolume',
  sfx: 'sfxVolume',
};

function cloneBindings(b: Settings['bindings']): Settings['bindings'] {
  const out = {} as Settings['bindings'];
  for (const a of CONTROL_ACTIONS) out[a] = [...(b[a] ?? [])];
  return out;
}

/**
 * Validate untrusted persisted bindings: invalid codes and duplicates are dropped, lists are
 * capped at BINDING_SLOTS. The user's explicit lists win: actions missing from the payload
 * (e.g. added in a later version) get their defaults minus any key the user already uses.
 */
export function sanitizeBindings(raw: unknown): Settings['bindings'] {
  if (!isRecord(raw)) return defaultBindings();
  const out: Partial<Settings['bindings']> = {};
  const seen = new Set<string>();
  const take = (source: readonly unknown[]): string[] => {
    const clean: string[] = [];
    for (const code of source) {
      if (clean.length >= BINDING_SLOTS) break;
      if (typeof code !== 'string' || code.length === 0 || code.length > 32 || seen.has(code)) continue;
      seen.add(code);
      clean.push(code);
    }
    return clean;
  };
  for (const a of CONTROL_ACTIONS) {
    const list = raw[a];
    if (Array.isArray(list)) out[a] = take(list);
  }
  for (const a of CONTROL_ACTIONS) if (!out[a]) out[a] = take(DEFAULT_BINDINGS[a]);
  return out as Settings['bindings'];
}

function sanitizeSettings(raw: unknown, current: Settings): Settings {
  if (!isRecord(raw)) return current;
  return {
    masterVolume: asUnit(raw.masterVolume, current.masterVolume),
    musicVolume: asUnit(raw.musicVolume, current.musicVolume),
    sfxVolume: asUnit(raw.sfxVolume, current.sfxVolume),
    muted: asBool(raw.muted, current.muted),
    quality: asOneOf(raw.quality, QUALITY_LEVELS, current.quality),
    cameraShake: asBool(raw.cameraShake, current.cameraShake),
    flightAssist: asBool(raw.flightAssist, current.flightAssist),
    showTrajectory: asBool(raw.showTrajectory, current.showTrajectory),
    tiltSteering: asBool(raw.tiltSteering, current.tiltSteering),
    bindings: 'bindings' in raw ? sanitizeBindings(raw.bindings) : current.bindings,
  };
}

function pickSettings(s: Settings): Settings {
  return {
    masterVolume: s.masterVolume,
    musicVolume: s.musicVolume,
    sfxVolume: s.sfxVolume,
    muted: s.muted,
    quality: s.quality,
    cameraShake: s.cameraShake,
    flightAssist: s.flightAssist,
    showTrajectory: s.showTrajectory,
    tiltSteering: s.tiltSteering,
    bindings: s.bindings,
  };
}

export const SETTINGS_STORAGE_KEY = 'roadster-flight.settings';
const SETTINGS_VERSION = 1;

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      ...defaultSettings(),

      setVolume: (kind, v) => {
        const value = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
        set({ [VOLUME_KEY[kind]]: value } as Partial<SettingsStore>);
      },
      setMuted: (muted) => set({ muted }),
      setQuality: (quality) => set({ quality: asOneOf(quality, QUALITY_LEVELS, get().quality) }),
      setCameraShake: (cameraShake) => set({ cameraShake }),
      setFlightAssist: (flightAssist) => set({ flightAssist }),
      setShowTrajectory: (showTrajectory) => set({ showTrajectory }),
      setTiltSteering: (tiltSteering) => set({ tiltSteering }),

      setBinding: (action, index, code) => {
        const next = cloneBindings(get().bindings);
        let displaced: BindingChange['displaced'] = null;
        if (code) {
          // A key drives exactly one action: remove it from every other slot first.
          for (const a of CONTROL_ACTIONS) {
            const list = next[a];
            const i = list.indexOf(code);
            if (i === -1 || (a === action && i === index)) continue;
            if (a !== action && !displaced) displaced = { action: a, index: i };
            list.splice(i, 1);
          }
        }
        const list = next[action];
        if (code === null) {
          if (index >= 0 && index < list.length) list.splice(index, 1);
        } else {
          // Arrays stay compact: binding past the end appends.
          const slot = Math.max(0, Math.min(index, list.length));
          if (slot < list.length) list[slot] = code;
          else list.push(code);
          if (list.length > BINDING_SLOTS) list.length = BINDING_SLOTS;
        }
        set({ bindings: next });
        return { displaced };
      },
      resetBindings: () => set({ bindings: defaultBindings() }),
      resetAll: () => set({ ...defaultSettings() }),
    }),
    {
      name: SETTINGS_STORAGE_KEY,
      version: SETTINGS_VERSION,
      storage: createSafeStorage<Settings>(),
      partialize: (s) => pickSettings(s),
      // Older/newer payloads are passed through and validated field by field in `merge`.
      migrate: (persisted) => persisted as Settings,
      merge: (persisted, current) => ({ ...current, ...sanitizeSettings(persisted, pickSettings(current)) }),
    },
  ),
);

/** Codes currently bound to `action` (convenience for non-React callers). */
export function getBinding(action: ControlAction): readonly string[] {
  return useSettingsStore.getState().bindings[action] ?? [];
}

/** Action currently bound to `code`, if any. */
export function actionForCode(bindings: Settings['bindings'], code: string): ControlAction | null {
  for (const a of CONTROL_ACTIONS) if (bindings[a]?.includes(code)) return a;
  return null;
}
