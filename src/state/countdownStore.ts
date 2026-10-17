/**
 * Start countdown shown over the HUD: 3, 2, 1, then GO (0) for a moment. `null` = no countdown.
 * Written by GameController from the runner's `onCountdown` hook; not persisted.
 */
import { create } from 'zustand';

export interface CountdownState {
  /** 3, 2, 1 while counting, 0 = GO, null = hidden. */
  step: number | null;
  set(step: number | null): void;
}

export const useCountdownStore = create<CountdownState>()((set) => ({
  step: null,
  set: (step) => set({ step }),
}));
