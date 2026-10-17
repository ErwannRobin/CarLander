/**
 * Bottom-left instrument: speed dial (270° arc) with the thrust-fuel ring inside, plus the
 * vacuum annunciator when the level enables it.
 *
 * The speed arc encodes real limits: the cyan range runs to the wheel top speed
 * (TUNING.maxSpeed); beyond it is the boost zone (orange), reachable only with thrust, up to
 * TUNING.maxSpeedBoost.
 */
import { useState, type CSSProperties } from 'react';
import { useTouchUiActive } from '../touchUi';
import { KMH, TUNING } from '@/game/tuning';
import { useHudStore } from '@/state/hudStore';
import { Icon } from '../components/Icon';
import { ActionKeys } from '../components/Keys';
import { useGameEvent } from '../hooks';

const CX = 80;
const CY = 80;
const R_SPEED = 70;
const R_FUEL = 58;
const START = 135;
const SWEEP = 270;
const MAX_KMH = TUNING.maxSpeedBoost * KMH;
const WHEEL_KMH = TUNING.maxSpeed * KMH;

function polar(r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}

function arc(r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(r, a0);
  const [x1, y1] = polar(r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

const angleFor = (kmh: number) => START + (SWEEP * kmh) / MAX_KMH;

// Static geometry (computed once).
const SPEED_TRACK = arc(R_SPEED, START, START + SWEEP);
const WHEEL_ARC = arc(R_SPEED, START, angleFor(WHEEL_KMH));
const BOOST_ARC = arc(R_SPEED, angleFor(WHEEL_KMH), START + SWEEP);
const BOOST_ZONE = arc(R_SPEED + 6, angleFor(WHEEL_KMH), START + SWEEP);
const FUEL_ARC = arc(R_FUEL, START, START + SWEEP);
const TICKS = (() => {
  let d = '';
  for (let k = 0; k <= MAX_KMH + 0.01; k += 10) {
    const major = k % 50 === 0;
    const a = angleFor(k);
    const [x0, y0] = polar(R_SPEED - 4, a);
    const [x1, y1] = polar(R_SPEED - (major ? 10 : 7), a);
    d += `M${x0.toFixed(2)} ${y0.toFixed(2)}L${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }
  return d;
})();
const WHEEL_MARK = (() => {
  const a = angleFor(WHEEL_KMH);
  const [x0, y0] = polar(R_SPEED + 3, a);
  const [x1, y1] = polar(R_SPEED - 12, a);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}L${x1.toFixed(2)} ${y1.toFixed(2)}`;
})();

const dash = (frac: number): CSSProperties => {
  const f = Number.isFinite(frac) ? Math.min(1, Math.max(0, frac)) : 0;
  return { strokeDashoffset: 100 - f * 100, opacity: f > 0.004 ? 1 : 0 };
};

function VacuumIndicator() {
  const v = useHudStore((s) => s.vacuum);
  const [pulse, setPulse] = useState(0);
  useGameEvent('vacuumEngaged', () => setPulse((p) => p + 1));
  if (!v.available) return null;
  const word = v.mode === 'engaged' ? 'Engaged' : v.mode === 'armed' ? 'Armed' : 'Off';
  return (
    <div className="rf-vacuum rf-glass" data-mode={v.mode} role="status" aria-label={`Vacuum ${word}`}>
      <div className="rf-vacuum__head">
        <span className="rf-vacuum__name">Vacuum</span>
        <span className="rf-vacuum__state">{word}</span>
      </div>
      <div className="rf-vacuum__bar">
        <span style={{ transform: `scaleX(${v.strength})` }} />
      </div>
      <div className="rf-vacuum__foot">
        {v.mode === 'off' ? (
          <>
            <ActionKeys action="vacuum" />
            <span>Hold to engage</span>
          </>
        ) : v.mode === 'armed' ? (
          <span>No track in range</span>
        ) : (
          <>
            <span>Suction</span>
            <span className="rf-num rf-vacuum__pct">{Math.round(v.strength * 100)}%</span>
          </>
        )}
      </div>
      {pulse > 0 && <span key={pulse} className="rf-vacuum__pulse" aria-hidden="true" />}
    </div>
  );
}

/**
 * Touch layout: a thin fuel bar and the speed, nothing else. The bar is the shared tank of the
 * thrusters and the vertical booster.
 */
function TouchGauge() {
  const speedKmh = useHudStore((s) => s.speedKmh);
  const fuel = useHudStore((s) => s.fuel);
  const fuelPct = useHudStore((s) => s.fuelPct);
  const burning = useHudStore((s) => s.boosting || s.jumping);
  const [emptyFlash, setEmptyFlash] = useState(0);
  useGameEvent('fuelEmpty', () => setEmptyFlash((n) => n + 1));
  return (
    <div className="rf-hud__bl">
      <div
        className="rf-gauge"
        data-burning={burning || undefined}
        data-low={fuel < 0.15 || undefined}
        role="group"
        aria-label={`Speed ${speedKmh} kilometres per hour, fuel ${fuelPct} percent`}
      >
        <div className="rf-gauge__fuel">
          <Icon name="thrust" className="rf-gauge__icon" />
          <span className="rf-gauge__bar">
            <span style={{ transform: `scaleX(${Number.isFinite(fuel) ? Math.min(1, Math.max(0, fuel)) : 0})` }} />
          </span>
        </div>
        <div className="rf-gauge__speed">
          <span className="rf-num">{speedKmh}</span>
          <span className="rf-gauge__unit">km/h</span>
        </div>
        {emptyFlash > 0 && <span key={emptyFlash} className="rf-gauge__empty" aria-hidden="true" />}
      </div>
      <VacuumIndicator />
    </div>
  );
}

export function SpeedCluster() {
  const touch = useTouchUiActive();
  return touch ? <TouchGauge /> : <SpeedDial />;
}

function SpeedDial() {
  const speedKmh = useHudStore((s) => s.speedKmh);
  const fuel = useHudStore((s) => s.fuel);
  const fuelPct = useHudStore((s) => s.fuelPct);
  const boosting = useHudStore((s) => s.boosting);
  const [emptyFlash, setEmptyFlash] = useState(0);
  useGameEvent('fuelEmpty', () => setEmptyFlash((n) => n + 1));

  const wheelFrac = speedKmh / WHEEL_KMH;
  const boostFrac = (speedKmh - WHEEL_KMH) / (MAX_KMH - WHEEL_KMH);

  return (
    <div className="rf-hud__bl">
      <div
        className="rf-speed"
        data-boosting={boosting || undefined}
        data-overspeed={speedKmh > WHEEL_KMH || undefined}
        data-low={fuel < 0.15 || undefined}
        role="group"
        aria-label={`Speed ${speedKmh} kilometres per hour, thrust fuel ${fuelPct} percent`}
      >
        <span className="rf-speed__face" aria-hidden="true" />
        <svg viewBox="0 0 160 160" aria-hidden="true">
          <path className="rf-speed__track" d={SPEED_TRACK} />
          <path className="rf-speed__zone" d={BOOST_ZONE} />
          <path className="rf-speed__ticks" d={TICKS} />
          <path className="rf-speed__mark" d={WHEEL_MARK} />
          <path className="rf-speed__fill" d={WHEEL_ARC} pathLength={100} style={dash(wheelFrac)} />
          <path className="rf-speed__fill rf-speed__fill--boost" d={BOOST_ARC} pathLength={100} style={dash(boostFrac)} />
          <path className="rf-fuel__track" d={FUEL_ARC} />
          <path className="rf-fuel__fill" d={FUEL_ARC} pathLength={100} style={dash(fuel)} />
        </svg>
        <div className="rf-speed__readout">
          <span className="rf-speed__value rf-num">{speedKmh}</span>
          <span className="rf-speed__unit">km/h</span>
        </div>
        <div className="rf-speed__fuel">
          {/* compact (touch) dials show the thrust glyph instead of the word — same icon as the THRUST button */}
          <Icon name="thrust" className="rf-speed__fuel-icon" />
          <span className="rf-speed__fuel-label">Thrust</span>
          <span className="rf-num">{fuelPct}%</span>
        </div>
        {emptyFlash > 0 && <span key={emptyFlash} className="rf-speed__empty" aria-hidden="true" />}
      </div>
      <VacuumIndicator />
    </div>
  );
}
