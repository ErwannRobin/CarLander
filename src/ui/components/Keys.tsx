/**
 * Key caps and adaptive control hints.
 *
 * Hints follow the last-used device: keyboard → the user's current bindings (layout-aware
 * labels), gamepad → button names, touch → on-screen control names.
 */
import type { ControlAction, ControlHint, Settings } from '@/game/types';
import type { InputMode } from '@/input/inputMode';
import { GAMEPAD_ACTION_LABELS, TOUCH_ACTION_LABELS, keyLabel, qwertyKeyLabel } from '@/input/keyNames';
import { CONTROL_ACTIONS, DEFAULT_BINDINGS, useSettingsStore } from '@/state/settingsStore';
import { useInputMode, useKeyLabelsVersion } from '../hooks';
import { Icon, type IconName } from './Icon';

type Bindings = Settings['bindings'];

/**
 * Default key name (as level authors write it, upper-cased) → action. Built from
 * DEFAULT_BINDINGS ('W' → accelerate, 'SPACE' → boost, 'SHIFT' → stabilize, '↑' → accelerate…)
 * plus a few common spellings.
 */
const AUTHORED_KEY_ACTION: ReadonlyMap<string, ControlAction> = (() => {
  const m = new Map<string, ControlAction>();
  for (const a of CONTROL_ACTIONS) {
    for (const code of DEFAULT_BINDINGS[a]) {
      const label = qwertyKeyLabel(code).toUpperCase();
      if (!m.has(label)) m.set(label, a);
    }
  }
  m.set('ESCAPE', 'pause');
  m.set('RETURN', 'vacuum');
  m.set('SPACEBAR', 'boost');
  return m;
})();

/**
 * Actions a hint refers to: its explicit `actions`, or — when the level author only wrote key
 * names — the actions those default keys map to, so caps still follow the player's bindings and
 * device. Null when any key name is unknown (the authored `keys` are then shown as written).
 */
export function hintActions(hint: ControlHint | null | undefined): readonly ControlAction[] | null {
  if (!hint) return null;
  if (hint.actions && hint.actions.length > 0) return hint.actions;
  if (!hint.keys || hint.keys.length === 0) return null;
  const out: ControlAction[] = [];
  for (const k of hint.keys) {
    const a = AUTHORED_KEY_ACTION.get(k.trim().toUpperCase());
    if (!a) return null;
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

/** Labels for one action in the given mode (keyboard: up to `max` bound keys). */
export function actionLabels(action: ControlAction, mode: InputMode, bindings: Bindings, max = 1): string[] {
  if (mode === 'gamepad') return [GAMEPAD_ACTION_LABELS[action]];
  if (mode === 'touch') return [TOUCH_ACTION_LABELS[action]];
  const codes = bindings[action] ?? [];
  if (codes.length === 0) return ['Unbound'];
  return codes.slice(0, max).map(keyLabel);
}

/** Labels for a hint (actions preferred over the static `keys`). Duplicates are merged. */
export function hintLabels(hint: ControlHint, mode: InputMode, bindings: Bindings): string[] {
  const actions = hintActions(hint);
  if (!actions) return hint.keys ?? [];
  const out: string[] = [];
  // On a pad, a hint naming both directions of an axis means the axis: W / S together is
  // "pitch" in the air → the left stick, not RT / LT (touch merges them into one stick cap too).
  const pitchAxis = mode === 'gamepad' && actions.includes('accelerate') && actions.includes('brake');
  if (pitchAxis) out.push(GAMEPAD_ACTION_LABELS.left);
  for (const a of actions) {
    if (pitchAxis && (a === 'accelerate' || a === 'brake')) continue;
    for (const l of actionLabels(a, mode, bindings)) if (!out.includes(l)) out.push(l);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrites default key names inside authored prompt text ("HOLD SPACE — FIRE THRUSTERS") to the
 * user's current control for that action ("HOLD F — …", "HOLD A — …" on gamepad).
 * Single letters are only replaced when they appear as standalone uppercase words.
 */
export function adaptHintText(text: string, hint: ControlHint | null, mode: InputMode, bindings: Bindings): string {
  const actions = hintActions(hint);
  if (!actions) return text;
  let out = text;
  for (const a of actions) {
    const def = DEFAULT_BINDINGS[a]?.[0];
    if (!def) continue;
    const defLabel = qwertyKeyLabel(def).toUpperCase();
    const current = actionLabels(a, mode, bindings)[0]?.toUpperCase();
    if (!current || current === defLabel || current === 'UNBOUND') continue;
    const flags = defLabel.length > 1 ? 'gi' : 'g';
    out = out.replace(new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(defLabel)}(?![A-Za-z0-9])`, flags), (_m, pre: string) => pre + current);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Touch hints: same icons as the on-screen buttons                    */
/* ------------------------------------------------------------------ */

interface TouchItem {
  key: string;
  icon: IconName;
  text?: string;
  label: string;
}

const TOUCH_ITEMS: Record<ControlAction, Omit<TouchItem, 'key'>> = {
  accelerate: { icon: 'stick', text: '↑', label: 'Stick up' },
  brake: { icon: 'stick', text: '↓', label: 'Stick down' },
  left: { icon: 'stick', text: '←', label: 'Stick left' },
  right: { icon: 'stick', text: '→', label: 'Stick right' },
  rollLeft: { icon: 'rollLeft', label: 'Roll left button' },
  rollRight: { icon: 'rollRight', label: 'Roll right button' },
  boost: { icon: 'thrust', label: 'Thrust button' },
  vacuum: { icon: 'vacuum', label: 'Vacuum button' },
  stabilize: { icon: 'stabilize', label: 'Stabilize button' },
  restart: { icon: 'restart', label: 'Restart button' },
  pause: { icon: 'pause', label: 'Pause button' },
};

/** Touch hint items; opposing stick directions merge into one item. */
export function touchItems(actions: readonly ControlAction[]): TouchItem[] {
  const out: TouchItem[] = [];
  const skip = new Set<ControlAction>();
  if (actions.includes('accelerate') && actions.includes('brake')) {
    out.push({ key: 'pitch', icon: 'stick', text: '↑↓', label: 'Stick up or down' });
    skip.add('accelerate').add('brake');
  }
  if (actions.includes('left') && actions.includes('right')) {
    out.push({ key: 'steer', icon: 'stick', text: '←→', label: 'Stick left or right' });
    skip.add('left').add('right');
  }
  for (const a of actions) if (!skip.has(a)) out.push({ key: a, ...TOUCH_ITEMS[a] });
  return out;
}

function TouchCaps({ actions, size }: { actions: readonly ControlAction[]; size: 'sm' | 'lg' }) {
  return (
    <span className="rf-keys">
      {touchItems(actions).map((it) => (
        <kbd
          key={it.key}
          className={`rf-keycap rf-keycap--touch ${size === 'lg' ? 'rf-keycap--lg' : ''}`}
          aria-label={it.label}
          title={it.label}
        >
          <Icon name={it.icon} className="rf-keycap__icon" />
          {it.text && <span className="rf-keycap__dir">{it.text}</span>}
        </kbd>
      ))}
    </span>
  );
}

export function KeyCap({
  label,
  size = 'sm',
  mode = 'keyboard',
  className,
}: {
  label: string;
  size?: 'sm' | 'lg';
  mode?: InputMode;
  className?: string;
}) {
  const cls = ['rf-keycap', size === 'lg' && 'rf-keycap--lg', mode !== 'keyboard' && `rf-keycap--${mode}`, label === 'Unbound' && 'rf-keycap--empty', className]
    .filter(Boolean)
    .join(' ');
  return <kbd className={cls}>{label}</kbd>;
}

/** Key caps for a ControlHint, adapted to the current device and bindings. */
export function HintKeys({ hint, size = 'sm' }: { hint: ControlHint; size?: 'sm' | 'lg' }) {
  const mode = useInputMode();
  const bindings = useSettingsStore((s) => s.bindings);
  useKeyLabelsVersion();
  const actions = hintActions(hint);
  if (mode === 'touch' && actions) return <TouchCaps actions={actions} size={size} />;
  const labels = hintLabels(hint, mode, bindings);
  return (
    <span className="rf-keys">
      {labels.map((l) => (
        <KeyCap key={l} label={l} size={size} mode={mode} />
      ))}
    </span>
  );
}

/** Key caps for an action's current binding(s). */
export function ActionKeys({ action, size = 'sm', max = 1 }: { action: ControlAction; size?: 'sm' | 'lg'; max?: number }) {
  const mode = useInputMode();
  const bindings = useSettingsStore((s) => s.bindings);
  useKeyLabelsVersion();
  if (mode === 'touch') return <TouchCaps actions={[action]} size={size} />;
  const labels = actionLabels(action, mode, bindings, max);
  return (
    <span className="rf-keys">
      {labels.map((l) => (
        <KeyCap key={l} label={l} size={size} mode={mode} />
      ))}
    </span>
  );
}

/**
 * Keyboard shortcut cap for a menu item. Hidden while a gamepad is the active device (the pad
 * navigates with the D-pad and A instead); touch layouts hide it in CSS.
 */
export function ShortcutKey({ action }: { action: ControlAction }) {
  const code = useSettingsStore((s) => s.bindings[action]?.[0]);
  const mode = useInputMode();
  useKeyLabelsVersion();
  if (!code || mode === 'gamepad') return null;
  return <KeyCap label={keyLabel(code)} />;
}
