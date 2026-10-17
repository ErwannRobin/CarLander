/**
 * Event-driven HUD moments: the trick feed (right edge) and the landing banner (centre).
 * Both subscribe to runtime.events; React state only changes when an event arrives.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { LandingQuality } from '@/game/types';
import { useHudStore } from '@/state/hudStore';
import { QUALITY_BANNER, formatFixed, formatMultiplier, formatPoints } from '../format';
import { useGameEvent, useRunReset } from '../hooks';

const FEED_LIFE_MS = 2800;
const MAX_FEED = 4;
let nextId = 1;

interface FeedItem {
  id: number;
  label: string;
  points: number;
}

export function TrickFeed() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const timers = useRef(new Set<number>());
  const combo = useHudStore((s) => s.airCombo);
  const airborne = useHudStore((s) => s.airborne);

  useEffect(() => {
    const set = timers.current;
    return () => {
      for (const t of set) window.clearTimeout(t);
      set.clear();
    };
  }, []);

  useGameEvent('trick', (e) => {
    const id = nextId++;
    setItems((list) => [...list.slice(-(MAX_FEED - 1)), { id, label: e.trick.label, points: e.trick.points }]);
    const t = window.setTimeout(() => {
      timers.current.delete(t);
      setItems((list) => list.filter((i) => i.id !== id));
    }, FEED_LIFE_MS);
    timers.current.add(t);
  });
  useRunReset(() => setItems([]));
  // A crash forfeits the jump's points: clear the feed (it would also sit on the crash banner on phones).
  useGameEvent('crash', () => setItems([]));

  return (
    <div className="rf-feed" aria-live="polite" style={{ '--life': `${FEED_LIFE_MS}ms` } as CSSProperties}>
      {items.map((item) => (
        <div key={item.id} className="rf-feed__item">
          <span className="rf-feed__label">{item.label}</span>
          <span className="rf-feed__pts rf-num">{formatPoints(item.points)}</span>
        </div>
      ))}
      {airborne && combo > 1 && (
        <div className="rf-feed__combo" key={combo}>
          Combo <span className="rf-num">{formatMultiplier(combo)}</span>
        </div>
      )}
    </div>
  );
}

interface BannerData {
  id: number;
  quality: Exclude<LandingQuality, 'crash'>;
  angleDeg: number;
  impactSpeed: number;
  points: number;
  multiplier: number;
  inTarget: boolean;
}

export function LandingBanner() {
  const [banner, setBanner] = useState<BannerData | null>(null);

  useGameEvent('landing', (e) => {
    const r = e.result;
    if (r.quality === 'crash') return; // crashes are presented by <CrashBanner/>
    setBanner({
      id: nextId++,
      quality: r.quality,
      angleDeg: r.angleDeg,
      impactSpeed: r.impactSpeed,
      points: r.points,
      multiplier: r.multiplier,
      inTarget: r.inTarget,
    });
  });
  useGameEvent('takeoff', () => setBanner(null));
  useRunReset(() => setBanner(null));
  useGameEvent('crash', () => setBanner(null));

  const life = banner?.quality === 'perfect' ? 3400 : 2800;
  useEffect(() => {
    if (!banner) return;
    const t = window.setTimeout(() => setBanner(null), life);
    return () => window.clearTimeout(t);
  }, [banner, life]);

  if (!banner) return null;
  return (
    <div
      key={banner.id}
      className="rf-landing"
      data-quality={banner.quality}
      role="status"
      aria-live="assertive"
      style={{ '--life': `${life}ms` } as CSSProperties}
    >
      <div className="rf-landing__word">{QUALITY_BANNER[banner.quality]}</div>
      <div className="rf-landing__rule" aria-hidden="true">
        <span />
      </div>
      <div className="rf-landing__stats">
        <span className="rf-landing__stat">
          Angle <b className="rf-num">{formatFixed(banner.angleDeg)}°</b>
        </span>
        <span className="rf-landing__stat">
          Impact <b className="rf-num">{formatFixed(banner.impactSpeed)}</b> m/s
        </span>
        {banner.inTarget && <span className="rf-landing__stat rf-landing__stat--target">On target</span>}
        {banner.points > 0 && (
          <span className="rf-landing__points">
            <b className="rf-num">{formatPoints(banner.points)}</b>
            {banner.multiplier > 1 && <span className="rf-num rf-landing__mult">{formatMultiplier(banner.multiplier)}</span>}
          </span>
        )}
      </div>
    </div>
  );
}
