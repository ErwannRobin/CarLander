/**
 * Gamepad menu navigation, mounted by <Screens/>. Active whenever a menu is up (title, level
 * select, pause, settings, level complete) and a pad is connected; inert during gameplay, where
 * the InputManager owns the pad.
 *
 *   D-pad / left stick  move focus to the nearest control in that direction (topmost layer only)
 *   left / right        on a slider or the quality selector: change its value instead
 *   A                   activate the focused control (first press focuses the default control)
 *   B                   back: an Escape key press, which every menu already handles
 *                       (resume, close settings, cancel key capture, level select → title)
 *   Start               confirm on the title and level select (in game it pauses / resumes)
 *
 * Focus moves with `focusVisible: true` so the selection ring shows even after mouse use.
 */
import { useEffect } from 'react';
import { startPadMenu, type MenuCommand } from '@/input/padMenu';
import { useAppStore } from '@/state/appStore';

type Direction = Extract<MenuCommand, 'up' | 'down' | 'left' | 'right'>;

/** Slider step per left / right press (sliders run 0..100). */
const SLIDER_STEP = 5;

/** The interactive layer on top: the last overlay (settings renders after pause / complete), else the screen. */
function menuLayer(): HTMLElement | null {
  const root = document.querySelector<HTMLElement>('.rf-root');
  if (!root) return null;
  const overlays = root.querySelectorAll<HTMLElement>('.rf-overlay');
  if (overlays.length > 0) return overlays[overlays.length - 1];
  return root.querySelector<HTMLElement>('.rf-title, .rf-levels');
}

function controlsIn(layer: HTMLElement): HTMLElement[] {
  return Array.from(layer.querySelectorAll<HTMLElement>('button, input, [tabindex]')).filter(
    (el) =>
      el.tabIndex >= 0 &&
      !(el as HTMLButtonElement | HTMLInputElement).disabled &&
      !el.closest('[inert]') &&
      el.getClientRects().length > 0,
  );
}

/** Where focus lands when nothing in the layer is focused: the primary action, else the first control. */
function defaultControl(controls: HTMLElement[]): HTMLElement | undefined {
  return controls.find((el) => el.classList.contains('rf-btn--primary')) ?? controls[0];
}

function focusControl(el: HTMLElement): void {
  el.focus({ focusVisible: true });
}

/** Rounding slack (px) when deciding whether a control lies past the current one. */
const EDGE_SLACK = 2;
/** Form rows (settings): vertical moves step row by row, whatever the control's position in it. */
const ROW_SELECTOR = '.rf-field, .rf-bind';

const gap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, b0 - a1, a0 - b1);

/**
 * Nearest control in `dir`, scored on edges (controls differ a lot in size): only controls
 * entirely past the current one along the travel axis count; the score is the gap along that
 * axis plus a heavier penalty for sideways offset, so lists and columns are followed before
 * jumping across. Vertical moves measure whole form rows (a switch sits at the far end of its
 * row, a slider in the middle of its own) and break ties by the controls' own sideways offset.
 */
function nearestControl(from: HTMLElement, controls: HTMLElement[], dir: Direction): HTMLElement | null {
  const vertical = dir === 'down' || dir === 'up';
  const own = from.getBoundingClientRect();
  const a = vertical ? (from.closest<HTMLElement>(ROW_SELECTOR) ?? from).getBoundingClientRect() : own;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of controls) {
    if (el === from) continue;
    const elOwn = el.getBoundingClientRect();
    const b = vertical ? (el.closest<HTMLElement>(ROW_SELECTOR) ?? el).getBoundingClientRect() : elOwn;
    let along: number;
    let across: number;
    let tieBreak: number;
    if (vertical) {
      along = dir === 'down' ? b.top - a.bottom : a.top - b.bottom;
      across = gap(a.left, a.right, b.left, b.right);
      tieBreak = gap(own.left, own.right, elOwn.left, elOwn.right);
    } else {
      along = dir === 'right' ? b.left - a.right : a.left - b.right;
      across = gap(a.top, a.bottom, b.top, b.bottom);
      tieBreak = 0;
    }
    if (along < -EDGE_SLACK) continue;
    const score = Math.max(0, along) + across * 3 + tieBreak * 0.01;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

/** Step a range input and notify React (it listens to `input` events through its value tracker). */
function nudgeSlider(input: HTMLInputElement, sign: 1 | -1): void {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const value = Math.min(max, Math.max(min, Number(input.value) + sign * SLIDER_STEP));
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setValue?.call(input, String(value));
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function keydown(target: EventTarget, key: string, code: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true }));
}

function focusedControl(controls: HTMLElement[]): HTMLElement | null {
  const el = document.activeElement;
  return el instanceof HTMLElement && controls.includes(el) ? el : null;
}

function move(dir: Direction): void {
  const layer = menuLayer();
  if (!layer) return;
  const controls = controlsIn(layer);
  const current = focusedControl(controls);
  if (!current) {
    const first = defaultControl(controls);
    if (first) focusControl(first);
    return;
  }
  if (dir === 'left' || dir === 'right') {
    if (current instanceof HTMLInputElement && current.type === 'range') {
      nudgeSlider(current, dir === 'right' ? 1 : -1);
      return;
    }
    if (current.getAttribute('role') === 'radio') {
      // the radio group (quality) moves its own selection on arrow keys
      keydown(current, dir === 'right' ? 'ArrowRight' : 'ArrowLeft', dir === 'right' ? 'ArrowRight' : 'ArrowLeft');
      return;
    }
  }
  const next = nearestControl(current, controls, dir);
  if (next) focusControl(next);
}

function confirm(): void {
  const layer = menuLayer();
  if (!layer) return;
  const controls = controlsIn(layer);
  const current = focusedControl(controls);
  if (!current) {
    // First press shows where the selection is instead of acting blind.
    const first = defaultControl(controls);
    if (first) focusControl(first);
    return;
  }
  if (current instanceof HTMLInputElement && current.type === 'range') return;
  current.click();
}

function back(): void {
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  keydown(target, 'Escape', 'Escape');
}

export function GamepadMenuNav() {
  const screen = useAppStore((s) => s.screen);
  const overlay = useAppStore((s) => s.overlay);
  const menuOpen = screen !== 'boot' && !(screen === 'playing' && overlay === 'none');
  // In game, Start belongs to the InputManager (pause / resume): never also "confirm" there.
  const startConfirms = screen === 'title' || screen === 'levelSelect';

  useEffect(() => {
    if (!menuOpen) return;
    return startPadMenu((command) => {
      switch (command) {
        case 'confirm':
          confirm();
          break;
        case 'start':
          if (startConfirms) confirm();
          break;
        case 'back':
          back();
          break;
        default:
          move(command);
      }
    });
  }, [menuOpen, startConfirms]);

  return null;
}
