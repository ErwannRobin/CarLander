/**
 * Whether on-screen touch controls are currently shown (set by <TouchControls/>), so the HUD
 * can lift its bottom clusters clear of the thumbs. Tiny external store.
 */
import { useSyncExternalStore } from 'react';

let active = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of [...listeners]) l();
}

/** Register a mounted touch-control layer; returns the matching unregister function. */
export function registerTouchUi(): () => void {
  active++;
  emit();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    active--;
    emit();
  };
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useTouchUiActive(): boolean {
  return useSyncExternalStore(subscribe, () => active > 0, () => false);
}
