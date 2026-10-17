/**
 * On-screen controls for coarse pointers.
 *
 *  - Steering: the phone itself (tilt it like a steering wheel, src/input/gyro.ts). GAS and BRAKE
 *    pedals sit under the left thumb (in the air they pitch the nose down / up).
 *    Without a usable tilt sensor (or with the setting off) a floating left thumb stick steers and
 *    drives instead.
 *  - Right thumb: THRUST and JUMP (the vertical booster). Above them, only when they matter:
 *    VACUUM (levels that have it), and in the air STABILIZE and ROLL L / ROLL R.
 *  - Camera: drag a finger over the scene to orbit the chase camera; it drifts back behind the
 *    car a moment after the finger lifts, and a tap puts it back at once.
 *
 * Pause is the HUD's only button. Multi-touch safe: each control tracks its own pointer ids with
 * pointer capture. Writes the module-level `touchInput` / `cameraLook` (src/input/touchInput.ts) —
 * no React state per move.
 */
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { initGyro, setGyroEnabled } from '@/input/gyro';
import { setInputMode } from '@/input/inputMode';
import { cameraLook, resetCameraLook, resetTouchInput, touchInput } from '@/input/touchInput';
import { useAppStore } from '@/state/appStore';
import { useHudStore } from '@/state/hudStore';
import { useSettingsStore } from '@/state/settingsStore';
import { Icon, type IconName } from './components/Icon';
import { useCoarsePointer, useTiltSteering } from './hooks';
import { registerTouchUi } from './touchUi';
import './styles/tokens.css';
import './styles/touch.css';

const STICK_DEADZONE = 0.12;

/** Radial deadzone + mild expo on the stick magnitude (precise near centre, full at the rim). */
function shapeMagnitude(m: number): number {
  if (m <= STICK_DEADZONE) return 0;
  const n = Math.min(1, (m - STICK_DEADZONE) / (1 - STICK_DEADZONE));
  return n * (0.55 + 0.45 * n);
}

/** Pointer capture can throw if the pointer is already gone; the control still works without it. */
function capture(el: Element, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Stick                                                               */
/* ------------------------------------------------------------------ */

function Stick({ enabled }: { enabled: boolean }) {
  const zoneRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ id: -1, cx: 0, cy: 0, r: 1 });

  const release = () => {
    drag.current.id = -1;
    touchInput.steer = 0;
    touchInput.throttle = 0;
    const base = baseRef.current;
    const knob = knobRef.current;
    if (base) {
      base.style.transform = '';
      base.removeAttribute('data-active');
    }
    if (knob) knob.style.transform = '';
  };

  useEffect(() => {
    if (!enabled) release();
  }, [enabled]);
  useEffect(() => release, []);

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled || drag.current.id !== -1) return;
    const zone = zoneRef.current;
    const base = baseRef.current;
    if (!zone || !base) return;
    e.preventDefault();
    capture(zone, e.pointerId);
    setInputMode('touch');
    const z = zone.getBoundingClientRect();
    const b = base.getBoundingClientRect();
    const r = b.width / 2;
    // Floating stick: the base jumps under the thumb (kept fully inside the zone).
    const cx = Math.min(z.right - r, Math.max(z.left + r, e.clientX));
    const cy = Math.min(z.bottom - r, Math.max(z.top + r, e.clientY));
    const restX = b.left + r;
    const restY = b.top + r;
    base.style.transform = `translate(${cx - restX}px, ${cy - restY}px)`;
    base.setAttribute('data-active', '');
    drag.current = { id: e.pointerId, cx, cy, r: r * 0.78 };
    move(e.clientX, e.clientY);
  };

  const move = (x: number, y: number) => {
    const d = drag.current;
    let dx = x - d.cx;
    let dy = y - d.cy;
    const len = Math.hypot(dx, dy);
    if (len > d.r) {
      dx = (dx / len) * d.r;
      dy = (dy / len) * d.r;
    }
    if (knobRef.current) knobRef.current.style.transform = `translate(${dx}px, ${dy}px)`;
    if (len < 1e-6) {
      touchInput.steer = 0;
      touchInput.throttle = 0;
      return;
    }
    // Curve the radial magnitude, then map circle → square so a full diagonal push gives full
    // throttle AND full steer (radial clamping alone would cap each axis at ~0.71).
    const clamped = Math.hypot(dx, dy);
    const ux = dx / clamped;
    const uy = dy / clamped;
    const m = shapeMagnitude(Math.min(1, len / d.r));
    const k = 1 / Math.max(Math.abs(ux), Math.abs(uy));
    touchInput.steer = Math.max(-1, Math.min(1, ux * m * k));
    touchInput.throttle = Math.max(-1, Math.min(1, -uy * m * k));
  };

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== drag.current.id) return;
    move(e.clientX, e.clientY);
  };

  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== drag.current.id) return;
    release();
  };

  return (
    <div
      ref={zoneRef}
      className="rf-stick-zone"
      data-interactive
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onLostPointerCapture={onUp}
    >
      <div ref={baseRef} className="rf-stick" aria-hidden="true">
        <span className="rf-stick__ring" />
        <span className="rf-stick__ticks" />
        <div ref={knobRef} className="rf-stick__knob" />
      </div>
      <span className="rf-visually-hidden">Steering and throttle stick</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

function TouchButton({
  label,
  icon,
  variant,
  enabled,
  hidden = false,
  onChange,
}: {
  label: string;
  icon: IconName;
  variant: string;
  enabled: boolean;
  /** Faded out and click-through (controls that only matter in some situations). */
  hidden?: boolean;
  onChange: (pressed: boolean) => void;
}) {
  const pointers = useRef(new Set<number>());
  const [pressed, setPressed] = useState(false);
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => {
    onChangeRef.current = onChange;
  });

  const releaseAll = () => {
    if (pointers.current.size === 0) return;
    pointers.current.clear();
    onChangeRef.current(false);
    setPressed(false);
  };
  useEffect(() => {
    if (!enabled) releaseAll();
  }, [enabled]);
  useEffect(() => releaseAll, []);

  const down = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!enabled) return;
    e.preventDefault();
    capture(e.currentTarget, e.pointerId);
    pointers.current.add(e.pointerId);
    if (pointers.current.size === 1) {
      onChangeRef.current(true);
      setPressed(true);
      setInputMode('touch');
    }
  };
  const up = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!pointers.current.delete(e.pointerId)) return;
    if (pointers.current.size === 0) {
      onChangeRef.current(false);
      setPressed(false);
    }
  };

  return (
    <button
      type="button"
      className={`rf-tbtn rf-tbtn--${variant}`}
      data-pressed={pressed || undefined}
      data-hidden={hidden || undefined}
      aria-label={label}
      aria-pressed={pressed}
      tabIndex={-1}
      onPointerDown={down}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Icon name={icon} className="rf-tbtn__icon" />
      <span className="rf-tbtn__label">{label}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Camera look                                                         */
/* ------------------------------------------------------------------ */

/** Radians of orbit per dragged pixel. */
const LOOK_YAW_PER_PX = 0.0075;
const LOOK_PITCH_PER_PX = 0.0055;
/** Highest and lowest the boom may be swung (rad, relative to the framing the camera would use). */
const LOOK_PITCH_MAX = 1.1;
const LOOK_PITCH_MIN = -0.25;
/** A touch that moves less than this (px) and ends within TAP_MS is a tap. */
const TAP_SLOP = 10;
const TAP_MS = 260;

const wrapPi = (a: number) => a - Math.PI * 2 * Math.round(a / (Math.PI * 2));

/** The whole screen is a camera handle (under the HUD and the buttons). */
function LookPad({ enabled }: { enabled: boolean }) {
  const drag = useRef({ id: -1, x: 0, y: 0, t: 0, moved: 0 });

  const end = (cancel: boolean, at = 0) => {
    const d = drag.current;
    if (d.id === -1) return;
    const tap = !cancel && d.moved < TAP_SLOP && at - d.t < TAP_MS;
    d.id = -1;
    if (tap) resetCameraLook();
    cameraLook.dragging = false;
    cameraLook.idle = 0;
  };

  useEffect(() => {
    if (!enabled) end(true);
  }, [enabled]);
  useEffect(() => () => end(true), []);

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled || drag.current.id !== -1) return;
    e.preventDefault();
    capture(e.currentTarget, e.pointerId);
    setInputMode('touch');
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, moved: 0 };
    cameraLook.dragging = true;
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (e.pointerId !== d.id) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    d.moved += Math.abs(dx) + Math.abs(dy);
    // like grabbing the scene: dragging right swings the camera round to the car's left, dragging down lifts it
    cameraLook.yaw = wrapPi(cameraLook.yaw - dx * LOOK_YAW_PER_PX);
    cameraLook.pitch = Math.min(LOOK_PITCH_MAX, Math.max(LOOK_PITCH_MIN, cameraLook.pitch + dy * LOOK_PITCH_PER_PX));
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerId === drag.current.id) end(e.type !== 'pointerup', e.timeStamp);
  };

  return (
    <div
      className="rf-layer rf-look"
      data-disabled={!enabled || undefined}
      data-interactive
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onLostPointerCapture={onUp}
    />
  );
}

/* ------------------------------------------------------------------ */
/* First-run hint                                                      */
/* ------------------------------------------------------------------ */

/** The hint is shown once per page load: the controls are not documented anywhere else on a phone. */
let hintShown = false;

function TouchHint({ tilt }: { tilt: boolean }) {
  const [show] = useState(!hintShown);
  useEffect(() => {
    hintShown = true;
  }, []);
  if (!show) return null;
  return (
    <div className="rf-touch__hint" aria-hidden="true">
      {tilt ? 'Tilt the phone to steer' : 'Drag the stick to steer'} · Drag the scene to look around
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Layer                                                               */
/* ------------------------------------------------------------------ */

function TouchLayer() {
  const overlay = useAppStore((s) => s.overlay);
  const vacuumAvailable = useHudStore((s) => s.vacuum.available);
  const airborne = useHudStore((s) => s.airborne);
  const tiltSetting = useSettingsStore((s) => s.tiltSteering);
  const tilt = useTiltSteering();
  const enabled = overlay === 'none';
  const roll = useRef({ left: false, right: false });
  const pedals = useRef({ gas: false, brake: false });

  useEffect(() => {
    touchInput.active = true;
    resetCameraLook();
    initGyro();
    const unregister = registerTouchUi();
    return () => {
      resetTouchInput();
      resetCameraLook();
      touchInput.active = false;
      unregister();
    };
  }, []);
  useEffect(() => {
    setGyroEnabled(tiltSetting);
  }, [tiltSetting]);

  const setRoll = (side: 'left' | 'right', v: boolean) => {
    roll.current[side] = v;
    touchInput.roll = (roll.current.right ? 1 : 0) - (roll.current.left ? 1 : 0);
  };
  const setPedal = (pedal: 'gas' | 'brake', v: boolean) => {
    pedals.current[pedal] = v;
    touchInput.throttle = (pedals.current.gas ? 1 : 0) - (pedals.current.brake ? 1 : 0);
  };

  return (
    <>
      <LookPad enabled={enabled} />
      <div
        className="rf-layer rf-touch"
        data-scheme={tilt ? 'tilt' : 'stick'}
        data-disabled={!enabled || undefined}
        inert={!enabled || undefined}
      >
        <TouchHint tilt={tilt} />
        {tilt ? (
          <div className="rf-touch__pedals">
            <TouchButton label="Brake" icon="brake" variant="brake" enabled={enabled} onChange={(v) => setPedal('brake', v)} />
            <TouchButton label="Gas" icon="gas" variant="gas" enabled={enabled} onChange={(v) => setPedal('gas', v)} />
          </div>
        ) : (
          <Stick enabled={enabled} />
        )}
        <div className="rf-touch__main">
          <TouchButton label="Thrust" icon="thrust" variant="thrust" enabled={enabled} onChange={(v) => (touchInput.boost = v)} />
          <TouchButton label="Jump" icon="jump" variant="jump" enabled={enabled} onChange={(v) => (touchInput.jump = v)} />
        </div>
        <div className="rf-touch__aux">
          {vacuumAvailable && (
            <TouchButton label="Vacuum" icon="vacuum" variant="vacuum" enabled={enabled} onChange={(v) => (touchInput.vacuum = v)} />
          )}
          <TouchButton
            label="Stabilize"
            icon="stabilize"
            variant="stabilize"
            enabled={enabled && airborne}
            hidden={!airborne}
            onChange={(v) => (touchInput.stabilize = v)}
          />
          <TouchButton label="Roll R" icon="rollRight" variant="roll" enabled={enabled && airborne} hidden={!airborne} onChange={(v) => setRoll('right', v)} />
          <TouchButton label="Roll L" icon="rollLeft" variant="roll" enabled={enabled && airborne} hidden={!airborne} onChange={(v) => setRoll('left', v)} />
        </div>
      </div>
    </>
  );
}

export interface TouchControlsProps {
  /** Show even without a coarse pointer (sandbox / testing). */
  force?: boolean;
}

export function TouchControls({ force = false }: TouchControlsProps) {
  const coarse = useCoarsePointer();
  if (!force && !coarse) return null;
  return <TouchLayer />;
}
