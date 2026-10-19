/**
 * Level complete: medal reveal, score count-up, breakdown rows (from result.breakdown),
 * final landing + run stats, NEW BEST badges, and Next level / Retry / Level select.
 *
 * One orchestrated sequence: breakdown rows stagger in, the score counts up, then the medal
 * flips in with a glint and the new-best badges land. Buttons are usable immediately.
 * Reduced motion: everything is shown in its final state.
 */
import { useLayoutEffect, useRef, type CSSProperties } from 'react';
import { useAppStore } from '@/state/appStore';
import { useSettingsStore } from '@/state/settingsStore';
import { QualityBadge } from './components/Controls';
import { Icon } from './components/Icon';
import { ShortcutKey } from './components/Keys';
import { Medal } from './components/Medal';
import { MEDAL_LABEL, QUALITY_BANNER, formatFixed, formatInt, formatPoints, formatTime } from './format';
import { LEVEL_CATALOG } from './levelCatalog';
import { isShortcutChord, prefersReducedMotion, useArrowNav, useAutoFocus, useKeyDown, useRepeatActivationGuard } from './hooks';
import './styles/tokens.css';
import './styles/components.css';
import './styles/overlays.css';

const COUNT_DELAY = 450;
const COUNT_MS = 1500;

/** Animated number written straight to the DOM (no React state per frame). */
function CountUp({ value, delayMs = 0, durationMs = COUNT_MS }: { value: number; delayMs?: number; durationMs?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion()) {
      el.textContent = formatInt(value);
      return;
    }
    el.textContent = formatInt(0);
    const t0 = performance.now() + delayMs;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - t0) / durationMs));
      const eased = 1 - Math.pow(1 - t, 4);
      el.textContent = formatInt(value * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, delayMs, durationMs]);
  return <span ref={ref}>{formatInt(value)}</span>;
}

export function LevelComplete() {
  const result = useAppStore((s) => s.lastResult);
  const record = useAppStore((s) => s.lastRecord);
  const nextLevel = useAppStore((s) => s.nextLevel);
  const restart = useAppStore((s) => s.restart);
  const goLevelSelect = useAppStore((s) => s.goLevelSelect);
  const restartCodes = useSettingsStore((s) => s.bindings.restart);

  const rootRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  useAutoFocus(primaryRef, !!result);
  useArrowNav(rootRef, 'horizontal', !!result);
  useRepeatActivationGuard();
  useKeyDown(
    (e) => {
      // Cmd+R / Ctrl+R must still reload the page, not retry the level.
      if (e.repeat || isShortcutChord(e)) return;
      if (restartCodes?.includes(e.code)) {
        e.preventDefault();
        restart();
      }
    },
    { enabled: !!result },
  );

  if (!result) return null;
  const card = LEVEL_CATALOG[result.levelId];
  const hasNext = result.levelId < 4;
  const landing = result.finalLanding;
  const revealAt = COUNT_DELAY + COUNT_MS - 200;

  const stats: Array<{ label: string; value: string; unit?: string }> = [
    { label: 'Time', value: formatTime(result.time) },
    { label: 'Top speed', value: formatInt(result.stats.maxSpeedKmh), unit: 'km/h' },
    { label: 'Longest jump', value: formatInt(result.stats.longestJump), unit: 'm' },
    { label: 'Best air time', value: formatFixed(result.stats.maxAirTime, 2), unit: 's' },
    { label: 'Tricks', value: formatInt(result.stats.tricks) },
  ];
  if (result.stats.invertedDistance > 0) {
    stats.push({ label: 'Inverted', value: formatInt(result.stats.invertedDistance), unit: 'm' });
  }

  return (
    <div
      ref={rootRef}
      className="rf-layer rf-overlay rf-complete"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rf-complete-title"
      style={{ '--reveal': `${revealAt}ms` } as CSSProperties}
    >
      <div className="rf-complete__scrim" aria-hidden="true" />
      <div className="rf-complete__sheet">
        <header className="rf-complete__head">
          <p className="rf-complete__level">
            Level {result.levelId}
            <span className="rf-complete__level-name">{card.name}</span>
          </p>
          <h1 id="rf-complete-title" className="rf-complete__title">
            Level complete
          </h1>
        </header>

        <div className="rf-complete__grid">
          <section className="rf-complete__hero" aria-label="Result">
            <Medal medal={result.medal} size="lg" reveal className="rf-complete__medal" />
            <p className="rf-complete__medal-name">{result.medal === 'none' ? 'No medal this time' : `${MEDAL_LABEL[result.medal]} medal`}</p>
            <div className="rf-complete__score">
              <span className="rf-complete__score-label">Score</span>
              <span className="rf-complete__score-value rf-num" aria-label={formatInt(result.score)}>
                <CountUp value={result.score} delayMs={COUNT_DELAY} />
              </span>
            </div>
            {(record?.newBestScore || record?.newBestLanding) && (
              <div className="rf-complete__badges">
                {record.newBestScore && <span className="rf-badge">New best score</span>}
                {record.newBestLanding && <span className="rf-badge">New best landing</span>}
              </div>
            )}
          </section>

          <section className="rf-complete__detail" aria-label="Score breakdown">
            <ol className="rf-breakdown">
              {result.breakdown.map((row, i) => (
                <li key={`${row.label}-${i}`} className="rf-breakdown__row" style={{ animationDelay: `${200 + i * 90}ms` }}>
                  <span className="rf-breakdown__label">{row.label}</span>
                  <span className="rf-breakdown__value">{row.value}</span>
                  <span className="rf-breakdown__pts rf-num">{formatPoints(row.points)}</span>
                </li>
              ))}
              <li className="rf-breakdown__row rf-breakdown__row--total" style={{ animationDelay: `${200 + result.breakdown.length * 90}ms` }}>
                <span className="rf-breakdown__label">Total</span>
                <span className="rf-breakdown__value" />
                <span className="rf-breakdown__pts rf-num">{formatInt(result.score)}</span>
              </li>
            </ol>

            <div className="rf-complete__landing">
              <span className="rf-complete__landing-label">Final landing</span>
              <QualityBadge quality={landing.quality}>{QUALITY_BANNER[landing.quality]}</QualityBadge>
              <span className="rf-complete__landing-data">
                <span>
                  Angle <b className="rf-num">{formatFixed(landing.angleDeg)}°</b>
                </span>
                <span>
                  Impact <b className="rf-num">{formatFixed(landing.impactSpeed)}</b> m/s
                </span>
                <span>
                  Drift <b className="rf-num">{formatFixed(landing.driftDeg)}°</b>
                </span>
              </span>
            </div>

            <dl className="rf-complete__stats">
              {stats.map((s) => (
                <div key={s.label} className="rf-complete__stat">
                  <dt>{s.label}</dt>
                  <dd className="rf-num">
                    {s.value}
                    {s.unit && <span className="rf-unit">{s.unit}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>

        <footer className="rf-complete__actions">
          {hasNext ? (
            <button ref={primaryRef} type="button" className="rf-btn rf-btn--primary" data-nav onClick={nextLevel}>
              Next level
            </button>
          ) : (
            <button ref={primaryRef} type="button" className="rf-btn rf-btn--primary" data-nav onClick={goLevelSelect}>
              Level select
            </button>
          )}
          <button type="button" className="rf-btn" data-nav onClick={restart}>
            <Icon name="restart" className="rf-btn__icon" />
            Retry
            <ShortcutKey action="restart" />
          </button>
          {hasNext && (
            <button type="button" className="rf-btn rf-btn--quiet" data-nav onClick={goLevelSelect}>
              Level select
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
