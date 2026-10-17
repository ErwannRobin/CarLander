/**
 * Gamepad → menu commands (standard mapping), so a pad can drive the UI menus:
 *   D-pad / left stick → up / down / left / right (with keyboard-like auto-repeat)
 *   A → confirm, B → back, Start → start
 *
 * Polls from requestAnimationFrame only while a pad is connected. Buttons and directions already
 * held when polling starts are ignored until released, so the press that opened a menu (A on
 * "Play", Start to pause) never also acts inside it. A pad whose first button press is what
 * connects it (browsers expose pads only after an input) gets that press counted.
 *
 * During gameplay the InputManager owns the pad; callers start this only while a menu is open.
 */
import { setInputMode } from './inputMode';

export type MenuCommand = 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back' | 'start';
type Direction = 'up' | 'down' | 'left' | 'right';

/** Left-stick deflection that counts as a direction. */
const STICK_THRESHOLD = 0.55;
/** Auto-repeat while a direction is held (ms), like a held arrow key. */
const REPEAT_DELAY_MS = 380;
const REPEAT_INTERVAL_MS = 120;

const BUTTON_A = 0;
const BUTTON_B = 1;
const BUTTON_START = 9;
const DPAD_UP = 12;
const DPAD_DOWN = 13;
const DPAD_LEFT = 14;
const DPAD_RIGHT = 15;

const pressed = (b: GamepadButton | undefined): boolean => !!b && (b.pressed || b.value > 0.5);

function firstPad(): Gamepad | null {
  try {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (p && p.connected) return p;
    }
  } catch {
    /* Gamepad API blocked (permissions policy) */
  }
  return null;
}

function directionOf(gp: Gamepad): Direction | null {
  const b = gp.buttons;
  if (pressed(b[DPAD_UP])) return 'up';
  if (pressed(b[DPAD_DOWN])) return 'down';
  if (pressed(b[DPAD_LEFT])) return 'left';
  if (pressed(b[DPAD_RIGHT])) return 'right';
  const x = gp.axes[0] ?? 0;
  const y = gp.axes[1] ?? 0;
  if (Math.max(Math.abs(x), Math.abs(y)) < STICK_THRESHOLD) return null;
  // dominant axis only: diagonals don't jump two ways at once
  if (Math.abs(y) >= Math.abs(x)) return y < 0 ? 'up' : 'down';
  return x < 0 ? 'left' : 'right';
}

/** Start emitting menu commands from the first connected pad. Returns a stop function. */
export function startPadMenu(onCommand: (command: MenuCommand) => void, target: Window = window): () => void {
  let raf = 0;
  /** Previous-frame state; null = take the current state as "already held" on the next frame. */
  let prev: { a: boolean; b: boolean; start: boolean } | null = null;
  let heldDir: Direction | null = null;
  let nextRepeat = Infinity;

  const emit = (command: MenuCommand) => {
    setInputMode('gamepad');
    onCommand(command);
  };

  const tick = (now: number) => {
    raf = target.requestAnimationFrame(tick);
    const gp = firstPad();
    if (!gp) {
      prev = null;
      return;
    }
    const a = pressed(gp.buttons[BUTTON_A]);
    const b = pressed(gp.buttons[BUTTON_B]);
    const start = pressed(gp.buttons[BUTTON_START]);
    const dir = directionOf(gp);
    if (!prev) {
      // Latch whatever is held right now (it belongs to whatever opened this menu).
      prev = { a, b, start };
      heldDir = dir;
      nextRepeat = Infinity;
      return;
    }
    if (dir !== heldDir) {
      heldDir = dir;
      nextRepeat = now + REPEAT_DELAY_MS;
      if (dir) emit(dir);
    } else if (dir && now >= nextRepeat) {
      nextRepeat = now + REPEAT_INTERVAL_MS;
      emit(dir);
    }
    if (a && !prev.a) emit('confirm');
    if (b && !prev.b) emit('back');
    if (start && !prev.start) emit('start');
    prev.a = a;
    prev.b = b;
    prev.start = start;
  };

  const run = () => {
    if (raf === 0) raf = target.requestAnimationFrame(tick);
  };
  const halt = () => {
    if (raf !== 0) target.cancelAnimationFrame(raf);
    raf = 0;
  };
  const onConnected = () => {
    // The press that made the browser expose the pad is a real press: count it.
    if (raf === 0) {
      prev = { a: false, b: false, start: false };
      heldDir = null;
      nextRepeat = Infinity;
    }
    run();
  };
  const onDisconnected = () => {
    if (!firstPad()) {
      halt();
      prev = null;
    }
  };

  target.addEventListener('gamepadconnected', onConnected);
  target.addEventListener('gamepaddisconnected', onDisconnected);
  if (firstPad()) run();

  return () => {
    target.removeEventListener('gamepadconnected', onConnected);
    target.removeEventListener('gamepaddisconnected', onDisconnected);
    halt();
  };
}
