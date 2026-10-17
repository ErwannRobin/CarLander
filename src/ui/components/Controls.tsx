/**
 * Form controls for the settings panel: slider (native range), switch, segmented control.
 * All are keyboard accessible and labelled.
 */
import { useId, type CSSProperties, type ReactNode } from 'react';
import type { LandingQuality } from '@/game/types';
import { QUALITY_LABEL } from '../format';

export function Slider({
  label,
  value,
  onChange,
  disabled = false,
  dimmed = false,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  /** Still adjustable, but shown as inactive (e.g. while muted). */
  dimmed?: boolean;
}) {
  const id = useId();
  const pct = Math.round(value * 100);
  return (
    <div className="rf-field" data-disabled={disabled || undefined} data-dimmed={dimmed || undefined}>
      <label className="rf-field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="rf-slider"
        type="range"
        min={0}
        max={100}
        step={1}
        value={pct}
        disabled={disabled}
        aria-valuetext={`${pct} percent`}
        style={{ '--pct': `${pct}%` } as CSSProperties}
        onChange={(e) => onChange(Number(e.currentTarget.value) / 100)}
      />
      <output className="rf-field__value rf-num" htmlFor={id}>
        {pct}
      </output>
    </div>
  );
}

export function Switch({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string;
  detail?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="rf-field rf-field--switch">
      <div className="rf-field__text">
        <span className="rf-field__label" id={id}>
          {label}
        </span>
        {detail && <span className="rf-field__detail">{detail}</span>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={id}
        className="rf-switch"
        onClick={() => onChange(!checked)}
      >
        <span className="rf-switch__knob" />
      </button>
    </div>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  const id = useId();
  const move = (dir: 1 | -1) => {
    const i = options.findIndex((o) => o.value === value);
    const next = options[(i + dir + options.length) % options.length];
    onChange(next.value);
    requestAnimationFrame(() => document.getElementById(`${id}-${next.value}`)?.focus());
  };
  return (
    <div className="rf-field rf-field--segmented">
      <span className="rf-field__label" id={id}>
        {label}
      </span>
      <div
        className="rf-segmented"
        role="radiogroup"
        aria-labelledby={id}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            move(1);
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            e.preventDefault();
            move(-1);
          }
        }}
      >
        {options.map((o) => (
          <button
            key={o.value}
            id={`${id}-${o.value}`}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            tabIndex={o.value === value ? 0 : -1}
            className="rf-segmented__opt"
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function QualityBadge({ quality, children }: { quality: LandingQuality; children?: ReactNode }) {
  return (
    <span className={`rf-quality rf-quality--${quality}`}>
      <span className="rf-quality__dot" aria-hidden="true" />
      {children ?? QUALITY_LABEL[quality]}
    </span>
  );
}
