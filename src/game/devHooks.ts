import type { InputState, SimSnapshot } from './types';

/**
 * Development / QA hooks (also exposed as `window.__game` by the game controller):
 *  - `autopilot`: when set, replaces player input (used by headless browser playthroughs,
 *    screenshot automation and the level demo runs: `?autopilot=1`).
 */
export type AutopilotFn = (snapshot: SimSnapshot) => InputState;

export const devHooks: {
  autopilot: AutopilotFn | null;
} = {
  autopilot: null,
};
