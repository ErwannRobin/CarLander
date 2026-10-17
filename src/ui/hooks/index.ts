/**
 * Small React hooks shared by the UI.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { runtime } from '@/game/runtime';
import type { GameEvent, GameEventType } from '@/game/types';
import { getInputMode, subscribeInputMode, type InputMode } from '@/input/inputMode';
import { getKeyLabelsVersion, subscribeKeyLabels } from '@/input/keyNames';
import { useAppStore } from '@/state/appStore';

/* ------------------------------------------------------------------ */
/* Media queries                                                       */
/* ------------------------------------------------------------------ */

function matches(query: string): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      let mql: MediaQueryList;
      try {
        mql = window.matchMedia(query);
      } catch {
        return () => {};
      }
      mql.addEventListener('change', cb);
      return () => mql.removeEventListener('change', cb);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => matches(query), () => false);
}

export const useCoarsePointer = (): boolean => useMediaQuery('(pointer: coarse)');
export const useReducedMotion = (): boolean => useMediaQuery('(prefers-reduced-motion: reduce)');
export const prefersReducedMotion = (): boolean => matches('(prefers-reduced-motion: reduce)');

/* ------------------------------------------------------------------ */
/* Input mode / key label version                                      */
/* ------------------------------------------------------------------ */

export function useInputMode(): InputMode {
  return useSyncExternalStore(subscribeInputMode, getInputMode, () => 'keyboard' as InputMode);
}

/** Re-render when the keyboard layout map loads (key labels may change). */
export function useKeyLabelsVersion(): number {
  return useSyncExternalStore(subscribeKeyLabels, getKeyLabelsVersion, () => 0);
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

/** Subscribe to a runtime game event for the lifetime of the component. */
export function useGameEvent<T extends GameEventType>(
  type: T,
  handler: (e: Extract<GameEvent, { type: T }>) => void,
): void {
  const ref = useRef(handler);
  useLayoutEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    const off = runtime.events.on(type, (e) => ref.current(e));
    return () => {
      off();
    };
  }, [type]);
}

/**
 * Run `handler` whenever a run (re)starts: the sim's `reset` event, or a new `runNonce`
 * (startLevel / restart / nextLevel — a freshly loaded level doesn't necessarily emit `reset`).
 * Transient HUD feedback (trick feed, banners) must not leak into the next run.
 */
export function useRunReset(handler: () => void): void {
  const ref = useRef(handler);
  useLayoutEffect(() => {
    ref.current = handler;
  });
  useGameEvent('reset', () => ref.current());
  useEffect(
    () =>
      useAppStore.subscribe((s, prev) => {
        if (s.runNonce !== prev.runNonce) ref.current();
      }),
    [],
  );
}

/** Ctrl / Alt / Meta held: a browser or OS shortcut (Cmd+R, Ctrl+P…), never a menu hotkey. */
export const isShortcutChord = (e: KeyboardEvent): boolean => e.ctrlKey || e.metaKey || e.altKey;

/**
 * Window keydown listener. Events that happened before the listener was installed are
 * ignored (so the key press that opened an overlay can't immediately trigger it).
 */
export function useKeyDown(
  handler: (e: KeyboardEvent) => void,
  { enabled = true, capture = false }: { enabled?: boolean; capture?: boolean } = {},
): void {
  const ref = useRef(handler);
  useLayoutEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    const since = performance.now();
    const onKey = (e: KeyboardEvent) => {
      if (e.timeStamp > 0 && e.timeStamp < since) return;
      ref.current(e);
    };
    window.addEventListener('keydown', onKey, capture);
    return () => window.removeEventListener('keydown', onKey, capture);
  }, [enabled, capture]);
}

/* ------------------------------------------------------------------ */
/* Presence (mount → open, close → exit animation → unmount)          */
/* ------------------------------------------------------------------ */

export function usePresence(open: boolean, exitMs = 240): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const t = window.setTimeout(() => setMounted(false), exitMs);
    return () => window.clearTimeout(t);
  }, [open, exitMs]);
  return { mounted: open || mounted, closing: !open && mounted };
}

/* ------------------------------------------------------------------ */
/* Menu keyboard navigation                                            */
/* ------------------------------------------------------------------ */

/**
 * Arrow-key focus movement between `[data-nav]` elements inside `ref`. If nothing inside is
 * focused, the first arrow press focuses the first item.
 */
export function useArrowNav(
  ref: RefObject<HTMLElement | null>,
  axis: 'vertical' | 'horizontal' | 'both' = 'vertical',
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const root = ref.current;
      if (!root || e.altKey || e.ctrlKey || e.metaKey) return;
      const prev = (axis !== 'horizontal' && e.key === 'ArrowUp') || (axis !== 'vertical' && e.key === 'ArrowLeft');
      const next = (axis !== 'horizontal' && e.key === 'ArrowDown') || (axis !== 'vertical' && e.key === 'ArrowRight');
      if (!prev && !next) return;
      const active = document.activeElement as HTMLElement | null;
      if (active && active.tagName === 'INPUT' && (active as HTMLInputElement).type === 'range') return;
      const items = Array.from(root.querySelectorAll<HTMLElement>('[data-nav]')).filter(
        (el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null,
      );
      if (items.length === 0) return;
      e.preventDefault();
      const i = active ? items.indexOf(active) : -1;
      const n = items.length;
      const target = i === -1 ? items[0] : items[(i + (next ? 1 : -1) + n) % n];
      target.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ref, axis, enabled]);
}

/* ------------------------------------------------------------------ */
/* Held-key activation guard                                          */
/* ------------------------------------------------------------------ */

let repeatGuardUsers = 0;

/**
 * Auto-repeat of a held Enter / Space would activate whichever button receives focus next
 * (holding Enter on the title used to skip level select and start a level). Repeated presses
 * never activate UI buttons; the first press still works normally.
 */
function blockRepeatActivation(e: KeyboardEvent): void {
  if (!e.repeat || (e.key !== 'Enter' && e.key !== ' ')) return;
  const t = e.target;
  if (t instanceof HTMLElement && (t.tagName === 'BUTTON' || t.getAttribute('role') === 'button') && t.closest('.rf-layer')) {
    e.preventDefault();
  }
}

/** Install the guard while the calling component is mounted (shared, ref-counted listener). */
export function useRepeatActivationGuard(): void {
  useEffect(() => {
    if (repeatGuardUsers++ === 0) window.addEventListener('keydown', blockRepeatActivation, true);
    return () => {
      if (--repeatGuardUsers === 0) window.removeEventListener('keydown', blockRepeatActivation, true);
    };
  }, []);
}

/**
 * Focus the element once after mount (without scrolling). A gamepad player has no other way to
 * see the selection, so the focus ring is forced on when the pad is the active device (the
 * browser's own heuristic only knows about keyboard and pointer).
 */
export function useAutoFocus<T extends HTMLElement>(ref: RefObject<T | null>, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const id = requestAnimationFrame(() =>
      ref.current?.focus({ preventScroll: true, focusVisible: getInputMode() === 'gamepad' ? true : undefined }),
    );
    return () => cancelAnimationFrame(id);
  }, [ref, enabled]);
}
