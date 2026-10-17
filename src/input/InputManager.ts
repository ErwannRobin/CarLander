/**
 * Gameplay input: keyboard (rebindable, by KeyboardEvent.code) + gamepad (standard mapping)
 * + on-screen touch controls, merged into one InputState sampled once per fixed sim tick.
 *
 * - Opposing keys cancel (W+S → throttle 0).
 * - While enabled, bound keys are preventDefault-ed (no page scroll, no focused-button
 *   activation). While disabled (menus open) the keyboard belongs to the UI and nothing fires.
 * - A key must be pressed while enabled to count: keys held over from a menu are ignored
 *   until released and pressed again (prevents Enter from a menu engaging the vacuum).
 *   Gamepad buttons follow the same rule (A pressed on "Next level" doesn't fire the thrusters).
 * - Browser shortcuts with Ctrl / Alt / Meta are never captured (Cmd+R still reloads) — unless
 *   that Ctrl / Alt key is itself a bound game key the player is holding (Ctrl = stabilize).
 * - Actions (restart / pause) fire on the press edge only — no key-repeat.
 * - Everything is released on window blur and when the page is hidden, and when ⌘ is released
 *   (macOS drops the keyup of any key released while ⌘ is held).
 *
 * Gamepad (ARCHITECTURE §12): left stick steer + pitch, RT accelerate, LT brake, A thrust,
 * B vertical booster, RB vacuum, LB stabilize, X / Y roll left / right (+ right stick X as analog roll),
 * D-pad mirrors the left stick, Start = pause, Back = restart.
 * Start also fires 'pause' while disabled, so a pad can close the pause menu it opened
 * (connectInputToStores maps it to togglePause, which ignores it outside gameplay).
 * Pads are polled from rAF whenever one is connected, not only from sample(): the runner stops
 * sampling while the sim is frozen or crashed, and Start / Back presses must still register.
 */
import { NEUTRAL_INPUT, type ControlAction, type InputState } from '@/game/types';
import { DEFAULT_BINDINGS } from '@/state/settingsStore';
import { touchInput } from './touchInput';
import { setInputMode } from './inputMode';

export type InputAction = 'restart' | 'pause';
export type Bindings = Readonly<Record<ControlAction, readonly string[]>>;

const STICK_DEADZONE = 0.18;
const ROLL_STICK_DEADZONE = 0.3;
const TRIGGER_DEADZONE = 0.06;
const PAD_ACTIVITY = 0.35;
const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);

const clamp1 = (v: number) => (v < -1 ? -1 : v > 1 ? 1 : v);

function isEditableTarget(t: EventTarget | null): boolean {
  if (!t || !(t instanceof Element)) return false;
  if (t instanceof HTMLInputElement) {
    // Range sliders / checkboxes don't take text; everything else does.
    return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset'].includes(t.type);
  }
  return t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t as HTMLElement).isContentEditable;
}

/** Axis value with a deadzone, rescaled so output starts at 0 at the deadzone edge. */
function deadzone(v: number, dz: number): number {
  const a = Math.abs(v);
  if (a <= dz) return 0;
  return (Math.sign(v) * (a - dz)) / (1 - dz);
}

function buttonValue(b: GamepadButton | undefined): number {
  if (!b) return 0;
  const v = b.value || (b.pressed ? 1 : 0);
  return v <= TRIGGER_DEADZONE ? 0 : (v - TRIGGER_DEADZONE) / (1 - TRIGGER_DEADZONE);
}

const pressed = (b: GamepadButton | undefined) => !!b && (b.pressed || b.value > 0.5);

/** Standard-mapping buttons that drive held game actions, as bits of a mask (bit i = button i). */
const BIT_A = 1 << 0; // thrust
const BIT_B = 1 << 1; // vertical booster
const BIT_X = 1 << 2; // roll left
const BIT_Y = 1 << 3; // roll right
const BIT_LB = 1 << 4; // stabilize
const BIT_RB = 1 << 5; // vacuum

export class InputManager {
  private target: Window | null = null;
  private enabled = true;
  private bindings: Bindings = DEFAULT_BINDINGS;
  /** code → actions bound to it (rebuilt on setBindings). */
  private codeActions = new Map<string, ControlAction[]>();
  /** Physical keys currently held (fresh presses while enabled). */
  private down = new Set<string>();
  private listeners = new Set<(a: InputAction) => void>();
  private readonly state: InputState = { ...NEUTRAL_INPUT };

  // gamepad
  private padsConnected = 0;
  private lastPadPoll = -Infinity;
  /** rAF handle of the pad poll that runs while a pad is connected (0 = not running). */
  private padRaf = 0;
  private readonly pad = { throttle: 0, steer: 0, roll: 0, boost: false, jump: false, vacuum: false, stabilize: false };
  private padStart = false;
  private padBack = false;
  /**
   * Action buttons that were held when input (re)enabled or was cleared: ignored until released,
   * like held-over keys. Bit i = standard button index i. -1 = latch on the next poll — also the
   * initial value: a manager created as a level starts must not fire on the A press that chose it.
   */
  private padLatch = -1;

  constructor(bindings: Bindings = DEFAULT_BINDINGS) {
    this.setBindings(bindings);
  }

  /** Start listening on `target` (default: window). Idempotent. */
  attach(target: Window = window): void {
    if (this.target === target) return;
    this.detach();
    this.target = target;
    target.addEventListener('keydown', this.onKeyDown, { capture: true });
    target.addEventListener('keyup', this.onKeyUp, { capture: true });
    target.addEventListener('blur', this.onBlur);
    target.addEventListener('gamepadconnected', this.onPadConnected);
    target.addEventListener('gamepaddisconnected', this.onPadDisconnected);
    target.document.addEventListener('visibilitychange', this.onVisibility);
    // Pads connected before attach() only report after a button press; count what is visible now.
    this.padsConnected = this.countPads();
    this.syncPadLoop();
  }

  detach(): void {
    const t = this.target;
    if (!t) return;
    t.removeEventListener('keydown', this.onKeyDown, { capture: true });
    t.removeEventListener('keyup', this.onKeyUp, { capture: true });
    t.removeEventListener('blur', this.onBlur);
    t.removeEventListener('gamepadconnected', this.onPadConnected);
    t.removeEventListener('gamepaddisconnected', this.onPadDisconnected);
    t.document.removeEventListener('visibilitychange', this.onVisibility);
    this.stopPadLoop();
    this.target = null;
    this.clear();
  }

  /**
   * Current merged control state. Writes into `out` if given, otherwise into an internal
   * object that is reused on every call — copy it if you keep it across ticks.
   */
  sample(out: InputState = this.state): InputState {
    let throttle = 0;
    let steer = 0;
    let roll = 0;
    let boost = false;
    let jump = false;
    let vacuum = false;
    let stabilize = false;

    this.pollGamepad();

    if (this.enabled) {
      throttle = (this.held('accelerate') ? 1 : 0) - (this.held('brake') ? 1 : 0);
      steer = (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);
      roll = (this.held('rollRight') ? 1 : 0) - (this.held('rollLeft') ? 1 : 0);
      boost = this.held('boost');
      jump = this.held('jump');
      vacuum = this.held('vacuum');
      stabilize = this.held('stabilize');

      const p = this.pad;
      throttle += p.throttle;
      steer += p.steer;
      roll += p.roll;
      boost ||= p.boost;
      jump ||= p.jump;
      vacuum ||= p.vacuum;
      stabilize ||= p.stabilize;

      if (touchInput.active) {
        throttle += touchInput.throttle + touchInput.tiltThrottle;
        steer += touchInput.steer + touchInput.tilt;
        roll += touchInput.roll;
        boost ||= touchInput.boost;
        jump ||= touchInput.jump;
        vacuum ||= touchInput.vacuum;
        stabilize ||= touchInput.stabilize;
      }
    }

    out.throttle = clamp1(throttle);
    out.steer = clamp1(steer);
    out.roll = clamp1(roll);
    out.boost = boost;
    out.jump = jump;
    out.vacuum = vacuum;
    out.stabilize = stabilize;
    return out;
  }

  /**
   * Subscribe to discrete actions (restart / pause), press edge only. Keyboard actions and the
   * gamepad Back button fire only while enabled; gamepad Start fires 'pause' in menus too.
   * Returns an unsubscribe function.
   */
  onAction(cb: (a: InputAction) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  setBindings(b: Bindings): void {
    this.bindings = b;
    this.codeActions.clear();
    for (const action of Object.keys(b) as ControlAction[]) {
      for (const code of b[action] ?? []) {
        const list = this.codeActions.get(code);
        if (list) list.push(action);
        else this.codeActions.set(code, [action]);
      }
    }
  }

  /** Disable while menus/overlays are open: releases everything and stops capturing keys. */
  setEnabled(v: boolean): void {
    if (this.enabled === v) return;
    this.enabled = v;
    this.clear();
    this.syncPadLoop();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Release all held keys and gamepad axes. Pad buttons still held must be released to count again. */
  clear(): void {
    this.down.clear();
    const p = this.pad;
    p.throttle = 0;
    p.steer = 0;
    p.roll = 0;
    p.boost = false;
    p.jump = false;
    p.vacuum = false;
    p.stabilize = false;
    this.padLatch = -1;
  }

  /* ---------------------------------------------------------------- */

  private held(action: ControlAction): boolean {
    const codes = this.bindings[action];
    if (!codes) return false;
    for (let i = 0; i < codes.length; i++) if (this.down.has(codes[i])) return true;
    return false;
  }

  private emit(a: InputAction): void {
    for (const l of [...this.listeners]) l(a);
  }

  /**
   * Ctrl / Alt / Meta held for a browser or OS shortcut. A Ctrl or Alt key the player holds as a
   * bound game key (e.g. Ctrl = stabilize) is game input, so it must not swallow other game keys.
   * ⌘ / Win combos always belong to the system.
   */
  private isShortcut(e: KeyboardEvent): boolean {
    if (e.metaKey) return true;
    if (e.ctrlKey && !this.down.has('ControlLeft') && !this.down.has('ControlRight')) return true;
    if (e.altKey && !this.down.has('AltLeft') && !this.down.has('AltRight')) return true;
    return false;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const code = e.code;
    if (!code || !this.enabled || isEditableTarget(e.target)) return;
    if (!MODIFIER_CODES.has(code) && this.isShortcut(e)) return;
    const actions = this.codeActions.get(code);
    if (!actions) return;
    e.preventDefault();
    // Auto-repeat: either already held, or held over from a menu (ignored until re-pressed).
    if (e.repeat) return;
    this.down.add(code);
    setInputMode('keyboard');
    for (const a of actions) if (a === 'restart' || a === 'pause') this.emit(a);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const code = e.code;
    if (!code) return;
    if (code === 'MetaLeft' || code === 'MetaRight') {
      // macOS never sends keyup for keys released while ⌘ was held: release everything rather
      // than leave a key stuck "held" (the player simply presses it again).
      this.down.clear();
      return;
    }
    const wasDown = this.down.delete(code);
    // Swallow the keyup too, so a focused button is not activated by Space/Enter release.
    if (this.enabled && (wasDown || this.codeActions.has(code)) && !isEditableTarget(e.target)) e.preventDefault();
  };

  private onBlur = (): void => this.clear();

  private onVisibility = (): void => {
    if (this.target?.document.visibilityState === 'hidden') this.clear();
  };

  private onPadConnected = (): void => {
    this.padsConnected = Math.max(1, this.countPads());
    this.syncPadLoop();
  };

  private onPadDisconnected = (): void => {
    this.padsConnected = this.countPads();
    if (this.padsConnected === 0) this.clear();
    this.syncPadLoop();
  };

  /**
   * Run the rAF pad poll while attached and a pad is connected. sample() polls too (rate-limited,
   * so the two never double-count an edge), but it isn't called while the sim is paused, crashed
   * or complete — Start / Back must work then as well.
   */
  private syncPadLoop(): void {
    const t = this.target;
    const wanted = !!t && this.padsConnected > 0;
    if (wanted && t && this.padRaf === 0) this.padRaf = t.requestAnimationFrame(this.padLoop);
    else if (!wanted) this.stopPadLoop();
  }

  private padLoop = (): void => {
    this.padRaf = 0;
    const t = this.target;
    if (!t || this.padsConnected === 0) return;
    this.pollGamepad();
    this.padRaf = t.requestAnimationFrame(this.padLoop);
  };

  private stopPadLoop(): void {
    if (this.padRaf !== 0) this.target?.cancelAnimationFrame(this.padRaf);
    this.padRaf = 0;
  }

  private countPads(): number {
    try {
      const pads = navigator.getGamepads?.() ?? [];
      let n = 0;
      for (let i = 0; i < pads.length; i++) if (pads[i]?.connected) n++;
      return n;
    } catch {
      return 0;
    }
  }

  private pollGamepad(): void {
    if (this.padsConnected === 0 || typeof navigator === 'undefined' || !navigator.getGamepads) return;
    // sample() runs at the sim rate (120 Hz); pads update at display rate — poll at most every ~4 ms.
    const now = performance.now();
    if (now - this.lastPadPoll < 4) return;
    this.lastPadPoll = now;

    let gp: Gamepad | null = null;
    try {
      const pads = navigator.getGamepads();
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i];
        if (p && p.connected) {
          gp = p;
          break;
        }
      }
    } catch {
      gp = null;
    }
    const pad = this.pad;
    if (!gp) {
      pad.throttle = pad.steer = pad.roll = 0;
      pad.boost = pad.jump = pad.vacuum = pad.stabilize = false;
      this.padStart = this.padBack = false;
      return;
    }

    const ax = gp.axes;
    const bt = gp.buttons;
    // Radial deadzone on the left stick, rescaled.
    let lx = ax[0] ?? 0;
    let ly = ax[1] ?? 0;
    const mag = Math.hypot(lx, ly);
    if (mag <= STICK_DEADZONE) {
      lx = 0;
      ly = 0;
    } else {
      const k = Math.min(1, (mag - STICK_DEADZONE) / (1 - STICK_DEADZONE)) / mag;
      lx *= k;
      ly *= k;
    }
    const dUp = pressed(bt[12]) ? 1 : 0;
    const dDown = pressed(bt[13]) ? 1 : 0;
    const dLeft = pressed(bt[14]) ? 1 : 0;
    const dRight = pressed(bt[15]) ? 1 : 0;
    const rt = buttonValue(bt[7]);
    const lt = buttonValue(bt[6]);

    // Action buttons held when input (re)enabled stay ignored until released (see padLatch).
    const held =
      (pressed(bt[0]) ? BIT_A : 0) |
      (pressed(bt[1]) ? BIT_B : 0) |
      (pressed(bt[2]) ? BIT_X : 0) |
      (pressed(bt[3]) ? BIT_Y : 0) |
      (pressed(bt[4]) ? BIT_LB : 0) |
      (pressed(bt[5]) ? BIT_RB : 0);
    this.padLatch = this.padLatch === -1 ? held : this.padLatch & held;
    const live = held & ~this.padLatch;

    // Stick up (negative axis) = accelerate / nose down, like W.
    pad.throttle = clamp1(rt - lt - ly + dUp - dDown);
    pad.steer = clamp1(lx + dRight - dLeft);
    pad.roll = clamp1(deadzone(ax[2] ?? 0, ROLL_STICK_DEADZONE) + (live & BIT_Y ? 1 : 0) - (live & BIT_X ? 1 : 0));
    pad.boost = (live & BIT_A) !== 0;
    pad.jump = (live & BIT_B) !== 0;
    pad.vacuum = (live & BIT_RB) !== 0;
    pad.stabilize = (live & BIT_LB) !== 0;

    const start = pressed(bt[9]);
    const back = pressed(bt[8]);
    // Start toggles pause in gameplay and closes the pause menu (see the header); Back only
    // restarts during gameplay.
    if (start && !this.padStart) this.emit('pause');
    if (back && !this.padBack && this.enabled) this.emit('restart');
    this.padStart = start;
    this.padBack = back;

    if (
      Math.abs(pad.throttle) > PAD_ACTIVITY ||
      Math.abs(pad.steer) > PAD_ACTIVITY ||
      Math.abs(pad.roll) > PAD_ACTIVITY ||
      held !== 0 ||
      start ||
      back
    ) {
      setInputMode('gamepad');
    }
  }
}
