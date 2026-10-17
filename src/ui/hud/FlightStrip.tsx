/**
 * Bottom-centre flight strip, shown only while airborne: altitude, air time, distance, points
 * at stake, and the attitude indicator.
 *
 * The attitude indicator is a small artificial horizon of the car's pitch/roll error relative
 * to the *predicted landing surface*. Its rim marks the real landing tolerances
 * (TUNING.landing.perfect / clean angles) and everything is tinted by the predicted quality.
 * It animates at display rate from the ~30 Hz HUD data (smoothed, angle-unwrapped) by writing
 * SVG transforms directly — no React renders per frame.
 */
import { useEffect, useId, useRef } from 'react';
import { TUNING } from '@/game/tuning';
import { useHudStore } from '@/state/hudStore';
import { QUALITY_LABEL, formatFixed, formatPoints } from '../format';
import { usePresence } from '../hooks';

const R = 40;
const PX_PER_DEG = 0.9;
const MAX_OFFSET = 36;
const PERFECT = TUNING.landing.perfect.angleDeg;
const CLEAN = TUNING.landing.clean.angleDeg;

function rimArc(r: number, fromDeg: number, toDeg: number): string {
  // degrees measured from 12 o'clock, clockwise
  const p = (d: number) => {
    const a = ((d - 90) * Math.PI) / 180;
    return `${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`;
  };
  return `M${p(fromDeg)} A${r} ${r} 0 0 1 ${p(toDeg)}`;
}

const ZONE_CLEAN = rimArc(R + 4.5, -CLEAN, CLEAN);
const ZONE_PERFECT = rimArc(R + 4.5, -PERFECT, PERFECT);
const RIM_TICKS = [-60, -30, 30, 60]
  .map((d) => {
    const a = ((d - 90) * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return `M${(c * (R + 2)).toFixed(2)} ${(s * (R + 2)).toFixed(2)}L${(c * (R + 6)).toFixed(2)} ${(s * (R + 6)).toFixed(2)}`;
  })
  .join('');
const LADDER_PERFECT = `M-9 ${(-PERFECT * PX_PER_DEG).toFixed(2)}H9M-9 ${(PERFECT * PX_PER_DEG).toFixed(2)}H9`;
const LADDER_CLEAN = `M-14 ${(-CLEAN * PX_PER_DEG).toFixed(2)}H14M-14 ${(CLEAN * PX_PER_DEG).toFixed(2)}H14`;

const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

export function AttitudeIndicator() {
  const quality = useHudStore((s) => s.attitude.quality);
  const valid = useHudStore((s) => s.attitude.valid);
  const align = useHudStore((s) => s.attitude.alignmentDeg);
  const rollRef = useRef<SVGGElement>(null);
  const pitchRef = useRef<SVGGElement>(null);
  const pointerRef = useRef<SVGGElement>(null);
  const clipId = `rf-att-clip-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let pitch = 0;
    let roll = 0;
    let primed = false;
    // Last values written to the DOM (NaN = never): settled frames cost no DOM writes or strings.
    let shownY = NaN;
    let shownRoll = NaN;
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const a = useHudStore.getState().attitude;
      if (a.valid) {
        if (!primed) {
          pitch = a.pitchErrorDeg;
          roll = a.rollErrorDeg;
          primed = true;
        }
        const k = 1 - Math.exp(-dt * 18);
        pitch += (a.pitchErrorDeg - pitch) * k;
        roll = wrap180(roll + wrap180(a.rollErrorDeg - roll) * k);
      }
      const y = Math.round(Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, pitch * PX_PER_DEG)) * 100) / 100;
      const r = Math.round(-roll * 100) / 100;
      if (r !== shownRoll) {
        shownRoll = r;
        const rot = `rotate(${r})`;
        rollRef.current?.setAttribute('transform', rot);
        pointerRef.current?.setAttribute('transform', rot);
      }
      if (y !== shownY) {
        shownY = y;
        pitchRef.current?.setAttribute('transform', `translate(0 ${y})`);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const q = valid && quality ? quality : null;
  return (
    <div className="rf-att" data-quality={q ?? 'none'}>
      <svg className="rf-att__svg" viewBox="-50 -50 100 100" aria-hidden="true">
        <defs>
          <clipPath id={clipId}>
            <circle r={R} />
          </clipPath>
        </defs>
        <circle className="rf-att__face" r={R} />
        <g clipPath={`url(#${clipId})`}>
          <g ref={rollRef}>
            <g ref={pitchRef}>
              <rect className="rf-att__surface" x={-90} y={0} width={180} height={120} />
              <path className="rf-att__ladder" d={LADDER_CLEAN} />
              <path className="rf-att__ladder rf-att__ladder--perfect" d={LADDER_PERFECT} />
              <line className="rf-att__horizon" x1={-90} x2={90} y1={0} y2={0} />
            </g>
          </g>
        </g>
        <circle className="rf-att__rim" r={R} />
        <path className="rf-att__zone rf-att__zone--clean" d={ZONE_CLEAN} />
        <path className="rf-att__zone rf-att__zone--perfect" d={ZONE_PERFECT} />
        <path className="rf-att__ticks" d={RIM_TICKS} />
        <g ref={pointerRef}>
          <path className="rf-att__pointer" d={`M0 ${-R + 1} L-3.4 ${-R + 7} L3.4 ${-R + 7} Z`} />
        </g>
        {/* the car, seen from behind: fixed reference */}
        <path className="rf-att__car" d="M-19 0 H-8 L-5 3.5 H5 L8 0 H19" />
        <circle className="rf-att__dot" r={1.4} />
      </svg>
      <div className="rf-att__label">
        {q ? (
          <>
            <span className="rf-att__quality">{QUALITY_LABEL[q]}</span>
            <span className="rf-num rf-att__angle">{formatFixed(align)}°</span>
          </>
        ) : (
          <span className="rf-att__quality rf-att__quality--none">No landing in sight</span>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, unit, className }: { label: string; value: string; unit?: string; className?: string }) {
  return (
    <div className={`rf-flight__stat ${className ?? ''}`}>
      <span className="rf-flight__label">{label}</span>
      <span className="rf-flight__value rf-num">
        {value}
        {unit && <span className="rf-unit">{unit}</span>}
      </span>
    </div>
  );
}

export function FlightStrip() {
  const airborne = useHudStore((s) => s.airborne);
  const altitude = useHudStore((s) => s.altitude);
  const airTime = useHudStore((s) => s.airTime);
  const distance = useHudStore((s) => s.distance);
  const pending = useHudStore((s) => s.pendingPoints);
  const { mounted, closing } = usePresence(airborne, 260);
  if (!mounted) return null;
  return (
    <div className="rf-hud__bc">
      <div className="rf-flight rf-glass" data-closing={closing || undefined} role="group" aria-label="Flight data">
        <Stat label="Altitude" value={altitude === null ? '—' : altitude.toFixed(1)} unit="m" />
        <Stat label="Air time" value={airTime.toFixed(2)} unit="s" />
        <AttitudeIndicator />
        <Stat label="Distance" value={String(distance)} unit="m" className="rf-flight__stat--secondary" />
        <Stat label="At stake" value={pending > 0 ? formatPoints(pending) : '—'} className="rf-flight__stat--stake rf-flight__stat--secondary" />
      </div>
    </div>
  );
}
