/**
 * On-screen controls for coarse pointers: a floating left thumb stick (x = steer / yaw,
 * y = throttle / pitch) and a right-thumb button cluster (THRUST, STABILIZE, VACUUM when the
 * level has it, ROLL L / ROLL R). Pause and restart are the HUD's icon buttons (enlarged to
 * touch size on coarse pointers).
 *
 * Multi-touch safe: each control tracks its own pointer ids with pointer capture.
 * Writes the module-level `touchInput` (src/input/touchInput.ts) — no React state per move.
 */
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { setInputMode } from '@/input/inputMode';
import { resetTouchInput, touchInput } from '@/input/touchInput';
import { useAppStore } from '@/state/appStore';
import { useHudStore } from '@/state/hudStore';
import { Icon, type IconName } from './components/Icon';
import { useCoarsePointer } from './hooks';
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
  onChange,
}: {
  label: string;
  icon: IconName;
  variant: string;
  enabled: boolean;
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

function TouchLayer() {
  const overlay = useAppStore((s) => s.overlay);
  const vacuumAvailable = useHudStore((s) => s.vacuum.available);
  const enabled = overlay === 'none';
  const roll = useRef({ left: false, right: false });

  useEffect(() => {
    touchInput.active = true;
    const unregister = registerTouchUi();
    return () => {
      resetTouchInput();
      touchInput.active = false;
      unregister();
    };
  }, []);

  const setRoll = (side: 'left' | 'right', v: boolean) => {
    roll.current[side] = v;
    touchInput.roll = (roll.current.right ? 1 : 0) - (roll.current.left ? 1 : 0);
  };

  return (
    <div className="rf-layer rf-touch" data-disabled={!enabled || undefined} inert={!enabled || undefined}>
      <Stick enabled={enabled} />
      <div className="rf-touch__buttons">
        <TouchButton label="Thrust" icon="thrust" variant="thrust" enabled={enabled} onChange={(v) => (touchInput.boost = v)} />
        <TouchButton
          label="Stabilize"
          icon="stabilize"
          variant="stabilize"
          enabled={enabled}
          onChange={(v) => (touchInput.stabilize = v)}
        />
        {vacuumAvailable && (
          <TouchButton label="Vacuum" icon="vacuum" variant="vacuum" enabled={enabled} onChange={(v) => (touchInput.vacuum = v)} />
        )}
        <TouchButton label="Roll L" icon="rollLeft" variant="roll-l" enabled={enabled} onChange={(v) => setRoll('left', v)} />
        <TouchButton label="Roll R" icon="rollRight" variant="roll-r" enabled={enabled} onChange={(v) => setRoll('right', v)} />
      </div>
    </div>
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
