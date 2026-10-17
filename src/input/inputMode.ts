/**
 * Last-used input device, so the UI can show adaptive control hints (key caps for keyboard,
 * button names for gamepad, on-screen control names for touch). Tiny external store usable
 * with React's useSyncExternalStore.
 */
export type InputMode = 'keyboard' | 'gamepad' | 'touch';

function initialMode(): InputMode {
  try {
    if (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches) return 'touch';
  } catch {
    /* ignore */
  }
  return 'keyboard';
}

let mode: InputMode = initialMode();
const listeners = new Set<() => void>();

export function getInputMode(): InputMode {
  return mode;
}

export function setInputMode(next: InputMode): void {
  if (next === mode) return;
  mode = next;
  for (const l of [...listeners]) l();
}

export function subscribeInputMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
