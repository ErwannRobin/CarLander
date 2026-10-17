/**
 * Machined-metal medal disc (CSS conic/radial shading) with an engraved flight-arc glyph.
 * `none` renders an empty dashed socket.
 */
import type { LevelResult } from '@/game/types';
import { MEDAL_LABEL } from '../format';

export function Medal({
  medal,
  size = 'md',
  reveal = false,
  className,
}: {
  medal: LevelResult['medal'];
  size?: 'sm' | 'md' | 'lg';
  /** Play the reveal animation on mount. */
  reveal?: boolean;
  className?: string;
}) {
  const cls = ['rf-medal', `rf-medal--${medal}`, `rf-medal--${size}`, reveal && 'rf-medal--reveal', className].filter(Boolean).join(' ');
  return (
    <span className={cls} role="img" aria-label={medal === 'none' ? 'No medal' : `${MEDAL_LABEL[medal]} medal`}>
      {medal !== 'none' && (
        <svg className="rf-medal__glyph" viewBox="0 0 40 40" aria-hidden="true">
          {/* ballistic arc from a ramp lip to a landing deck — the game in one line */}
          <path d="M8 27 Q 19 5 32 25.5" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="0.01 2.6" />
          <path d="M5 29h9M26 27.5h9" fill="none" strokeWidth="2" strokeLinecap="round" />
          <circle cx="32" cy="25.5" r="1.6" strokeWidth="0" fill="currentColor" />
        </svg>
      )}
    </span>
  );
}
