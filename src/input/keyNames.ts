/**
 * Human labels for KeyboardEvent.code values and per-device action labels.
 *
 * Codes are physical keys; where the browser exposes the Keyboard Map API
 * (navigator.keyboard.getLayoutMap, Chromium) letter/digit/punctuation labels follow the
 * user's actual layout — e.g. KeyW shows "Z" on AZERTY.
 */
import type { ControlAction } from '@/game/types';

interface KeyboardLayoutMapLike {
  get(code: string): string | undefined;
}
interface NavigatorKeyboardLike {
  getLayoutMap(): Promise<KeyboardLayoutMapLike>;
}

let layoutMap: KeyboardLayoutMapLike | null = null;
let layoutVersion = 0;
const layoutListeners = new Set<() => void>();

function loadLayoutMap(): void {
  try {
    const kb = (navigator as Navigator & { keyboard?: NavigatorKeyboardLike }).keyboard;
    if (!kb || typeof kb.getLayoutMap !== 'function') return;
    kb.getLayoutMap()
      .then((map) => {
        layoutMap = map;
        layoutVersion++;
        for (const l of [...layoutListeners]) l();
      })
      .catch(() => {
        /* not allowed (e.g. in an iframe) — keep QWERTY labels */
      });
  } catch {
    /* ignore */
  }
}
if (typeof navigator !== 'undefined') loadLayoutMap();

/** Subscribe to layout-map availability (labels may change once it loads). */
export function subscribeKeyLabels(listener: () => void): () => void {
  layoutListeners.add(listener);
  return () => {
    layoutListeners.delete(listener);
  };
}
export function getKeyLabelsVersion(): number {
  return layoutVersion;
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

const SPECIAL: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Num Enter',
  Escape: 'Esc',
  Tab: 'Tab',
  Backspace: 'Backspace',
  CapsLock: 'Caps',
  ShiftLeft: 'Shift',
  ShiftRight: 'R Shift',
  ControlLeft: 'Ctrl',
  ControlRight: 'R Ctrl',
  AltLeft: IS_MAC ? 'Option' : 'Alt',
  AltRight: IS_MAC ? 'R Option' : 'R Alt',
  MetaLeft: IS_MAC ? 'Cmd' : 'Win',
  MetaRight: IS_MAC ? 'R Cmd' : 'R Win',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Insert: 'Ins',
  Delete: 'Del',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  ContextMenu: 'Menu',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num −',
  NumpadMultiply: 'Num ×',
  NumpadDivide: 'Num ÷',
  NumpadDecimal: 'Num .',
};

/** QWERTY labels for layout-dependent punctuation keys. */
const PUNCTUATION: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  IntlBackslash: '<',
};

function isLayoutDependent(code: string): boolean {
  return code.startsWith('Key') || code.startsWith('Digit') || code in PUNCTUATION;
}

/** Label of a physical key on a US-QWERTY keyboard (layout-independent). */
export function qwertyKeyLabel(code: string): string {
  if (!code) return '';
  const special = SPECIAL[code];
  if (special) return special;
  const punct = PUNCTUATION[code];
  if (punct) return punct;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}

/** Label of a physical key on the user's layout (falls back to QWERTY). */
export function keyLabel(code: string): string {
  if (!code) return '';
  if (layoutMap && isLayoutDependent(code)) {
    const k = layoutMap.get(code);
    if (k && k.trim()) return k.length === 1 ? k.toUpperCase() : k;
  }
  return qwertyKeyLabel(code);
}

/** Gamepad (standard mapping) control names per action — ARCHITECTURE §12. */
export const GAMEPAD_ACTION_LABELS: Record<ControlAction, string> = {
  accelerate: 'RT',
  brake: 'LT',
  left: 'L stick',
  right: 'L stick',
  rollLeft: 'X',
  rollRight: 'Y',
  boost: 'A',
  jump: 'B',
  vacuum: 'RB',
  stabilize: 'LB',
  restart: 'Back',
  pause: 'Start',
};

/** On-screen touch control names per action. */
export const TOUCH_ACTION_LABELS: Record<ControlAction, string> = {
  accelerate: 'Gas',
  brake: 'Brake',
  left: 'Tilt',
  right: 'Tilt',
  rollLeft: 'Roll L',
  rollRight: 'Roll R',
  boost: 'Thrust',
  jump: 'Jump',
  vacuum: 'Vacuum',
  stabilize: 'Stabilize',
  restart: 'Restart',
  pause: 'Pause',
};

/** Human names of actions (settings, control guide); `detail` explains the in-air meaning. */
export const ACTION_INFO: Record<ControlAction, { name: string; detail?: string }> = {
  accelerate: { name: 'Accelerate', detail: 'Nose down in the air' },
  brake: { name: 'Brake and reverse', detail: 'Nose up in the air' },
  left: { name: 'Steer left', detail: 'Yaw left in the air' },
  right: { name: 'Steer right', detail: 'Yaw right in the air' },
  rollLeft: { name: 'Roll left', detail: 'In the air' },
  rollRight: { name: 'Roll right', detail: 'In the air' },
  boost: { name: 'Thrusters' },
  jump: { name: 'Vertical booster', detail: 'Hop, or cushion a landing' },
  vacuum: { name: 'Vacuum', detail: 'Hold to stick to the track' },
  stabilize: { name: 'Stabilize', detail: 'Hold to level the car' },
  restart: { name: 'Restart' },
  pause: { name: 'Pause' },
};
