/**
 * Public audio types (re-exported by AudioEngine.ts).
 */

/** High-level audio scene. Drives music arrangement, ducking and whether vehicle layers may sound. */
export type AudioScene = 'title' | 'game' | 'paused' | 'complete';

/** Interface sounds. */
export type UiSound = 'hover' | 'click' | 'back' | 'start' | 'unlock' | 'toggle';

/**
 * Mix levels. `master` / `music` / `sfx` are perceptual slider values 0..1 — they are squared
 * internally (an audio-taper approximation, 0.5 ≈ -12 dB), so they can be bound straight to UI sliders
 * (`Settings.masterVolume` etc.).
 */
export interface AudioMix {
  master: number;
  music: number;
  sfx: number;
  muted: boolean;
}

export const DEFAULT_MIX: Readonly<AudioMix> = Object.freeze({ master: 0.85, music: 0.7, sfx: 0.9, muted: false });
