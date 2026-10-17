/**
 * Elevation-profile glyphs of the three levels (like a stage profile): hairline track,
 * support pylons down to the cloud deck, the intended flight path, and each level's
 * signature detail (thrust burn at the L1 lip, the L2 ring gate, the L3 crescent with its
 * red LED beam and lattice tower).
 */
import type { LevelId } from '@/game/types';

const CLOUD_Y = 88;

function Pylons({ xs }: { xs: Array<[number, number]> }) {
  return (
    <g className="rf-profile__pylons">
      {xs.map(([x, y]) => (
        <line key={x} x1={x} y1={y + 2} x2={x} y2={CLOUD_Y} />
      ))}
    </g>
  );
}

function Level1() {
  return (
    <>
      <Pylons xs={[[30, 60], [78, 60], [126, 60], [164, 56], [236, 57], [290, 76]]} />
      <path className="rf-profile__track" d="M8 60 H148 C156 60 164 57 172 51" />
      {/* apron at lip height, crest, landing slope carrying the rings, outrun to the finish deck */}
      <path className="rf-profile__track" d="M208 51 H222 C230 51 236 54 246 61 C256 68 266 72 280 73 H312" />
      {/* thrust burn just after the lip, then the ballistic arc onto the slope */}
      <path className="rf-profile__burn" d="M172 51 Q178 44 186 39" />
      <path className="rf-profile__path" d="M186 39 Q218 22 248 58" />
      {/* target rings seen edge-on on the slope */}
      <ellipse className="rf-profile__target" cx="252" cy="65" rx="15" ry="3" transform="rotate(31 252 65)" />
      <line className="rf-profile__target" x1="252" y1="60" x2="252" y2="65" />
    </>
  );
}

function Level2() {
  return (
    <>
      <Pylons xs={[[20, 62], [84, 52], [118, 62], [150, 50], [252, 40], [300, 62]]} />
      <path
        className="rf-profile__track"
        d="M8 62 H36 C44 62 46 52 52 52 C58 52 60 62 68 62 C76 62 78 52 84 52 C90 52 92 62 100 62 H136 C148 62 156 52 162 40"
      />
      <path className="rf-profile__track" d="M236 33 C252 40 268 58 290 62 H312" />
      <path className="rf-profile__path" d="M162 40 Q200 -4 240 35" />
      <circle className="rf-profile__gate" cx="200" cy="18" r="6.5" />
    </>
  );
}

function Level3() {
  return (
    <>
      {/* steel lattice tower behind the crescent */}
      <g className="rf-profile__truss">
        <line x1="270" y1="10" x2="270" y2={CLOUD_Y} />
        <line x1="282" y1="10" x2="282" y2={CLOUD_Y} />
        <path d="M270 16 L282 28 L270 40 L282 52 L270 64 L282 76 L270 88" />
      </g>
      <Pylons xs={[[136, 78], [176, 78], [24, 58], [70, 52]]} />
      {/* aerial approach: start runway, kicker, the void, onto the arena deck */}
      <path className="rf-profile__track" d="M64 82 H98 C103 82 106 80 109 77" />
      <path className="rf-profile__path" d="M109 77 Q114 72 121 78" />
      {/* deck → quarter pipe → vertical wall → overhang curling back into the inverted beam */}
      <path
        className="rf-profile__track"
        d="M120 78 H206 C236 78 256 66 260 44 C263 28 260 16 248 10 C220 5 180 5 150 8"
      />
      <path className="rf-profile__led" d="M248 6.4 C220 1.6 180 1.6 150 4.6" />
      <line className="rf-profile__release" x1="150" y1="2" x2="150" y2="13" />
      {/* release, fall, reorient, land on the distant ski-jump platform */}
      <path className="rf-profile__path" d="M148 10 Q118 12 100 44" />
      <path className="rf-profile__track" d="M104 46 C92 48 80 54 64 57 H12" />
    </>
  );
}

export function LevelProfile({ id, locked = false, className }: { id: LevelId; locked?: boolean; className?: string }) {
  return (
    <svg
      className={['rf-profile', locked && 'rf-profile--locked', className].filter(Boolean).join(' ')}
      viewBox="0 0 320 96"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <line className="rf-profile__clouds" x1="0" y1={CLOUD_Y} x2="320" y2={CLOUD_Y} />
      {id === 1 ? <Level1 /> : id === 2 ? <Level2 /> : <Level3 />}
    </svg>
  );
}
