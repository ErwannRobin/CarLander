/**
 * Level 2 canyon: colossal stepped sandstone walls on both sides of the course and eroded spires
 * rising out of the cloud sea. The course runs along −Z at x = 0; the low sun (azimuth 72°) rakes
 * the left walls (facing +X) gold and leaves the right walls backlit.
 *
 * Every rock is kept ≥ 60 m off the flight corridor (|x| ≤ 30 m) so it never meets the chase camera.
 */
import { CanyonWall, RockSpire } from '@/render/level';

/** Wall bases sit inside the cloud sea (canyon top −195). */
const WALL_BASE = -330;

interface WallSpec {
  /** Center along the course (z), distance off the centerline (|x|), width along z, rim height (y). */
  z: number;
  x: number;
  width: number;
  rim: number;
  seed: number;
  relief?: number;
  curve?: number;
}

// left (x < 0, facing +X, sunlit) and right (x > 0, facing −X, backlit)
const LEFT: WallSpec[] = [
  { z: 160, x: 230, width: 520, rim: 236, seed: 11 },
  { z: -330, x: 265, width: 560, rim: 262, seed: 12, relief: 34 },
  { z: -860, x: 320, width: 620, rim: 282, seed: 13, relief: 40 },
  { z: -1420, x: 360, width: 660, rim: 268, seed: 14, relief: 44 },
  { z: -1990, x: 300, width: 600, rim: 246, seed: 15, relief: 36 },
];
const RIGHT: WallSpec[] = [
  { z: 90, x: 245, width: 540, rim: 222, seed: 21 },
  { z: -420, x: 300, width: 600, rim: 248, seed: 22, relief: 36 },
  { z: -990, x: 390, width: 640, rim: 240, seed: 23, relief: 42 },
  { z: -1530, x: 345, width: 660, rim: 258, seed: 24, relief: 40 },
  { z: -2060, x: 285, width: 580, rim: 236, seed: 25, relief: 34 },
];

interface SpireSpec {
  x: number;
  z: number;
  /** Top height (y) and base radius (m). */
  top: number;
  radius: number;
  seed: number;
  lean?: number;
  taper?: number;
}

const SPIRE_BASE = -230;
export const L2_SPIRES: SpireSpec[] = [
  // kicker section: mid-ground rhythm on both sides
  { x: -128, z: -265, top: 150, radius: 24, seed: 31, lean: -2 },
  { x: 168, z: -150, top: 176, radius: 30, seed: 32, lean: 1.5 },
  { x: 150, z: -640, top: 96, radius: 22, seed: 33, taper: 0.5 },
  { x: -118, z: -820, top: 58, radius: 20, seed: 34 },
  // the chasm: the monumental group framing the big jump (ring towers stand on the two at z = gate)
  { x: -92, z: -1060, top: 34, radius: 24, seed: 35, lean: 2 },
  { x: 150, z: -1290, top: 74, radius: 32, seed: 36, lean: -2.5 },
  { x: -165, z: -1330, top: 128, radius: 26, seed: 37, lean: 1 },
  { x: 92, z: -1460, top: 10, radius: 26, seed: 38 },
  { x: -96, z: -1600, top: -20, radius: 30, seed: 39 },
  // far field beyond the finish
  { x: 70, z: -1900, top: 120, radius: 34, seed: 40, lean: -1.5 },
];

export function L2Canyon() {
  return (
    <group name="l2-canyon">
      {LEFT.map((w, i) => (
        <CanyonWall
          key={`l${i}`}
          name={`l2-wall-left-${i}`}
          position={[-w.x, WALL_BASE, w.z]}
          rotation={[0, Math.PI / 2, 0]}
          width={w.width}
          height={w.rim - WALL_BASE}
          relief={w.relief ?? 30}
          plateau={90}
          strata={34}
          resolution={6}
          seed={w.seed}
          curve={w.curve ?? 0}
        />
      ))}
      {RIGHT.map((w, i) => (
        <CanyonWall
          key={`r${i}`}
          name={`l2-wall-right-${i}`}
          position={[w.x, WALL_BASE, w.z]}
          rotation={[0, -Math.PI / 2, 0]}
          width={w.width}
          height={w.rim - WALL_BASE}
          relief={w.relief ?? 30}
          plateau={90}
          strata={34}
          resolution={6}
          seed={w.seed}
          curve={w.curve ?? 0}
        />
      ))}
      {/* the far end of the canyon, closing the view past the finish */}
      <CanyonWall name="l2-wall-end" position={[0, WALL_BASE, -2380]} width={980} height={540} relief={46} plateau={120} strata={36} resolution={7} seed={51} />
      {L2_SPIRES.map((s, i) => (
        <RockSpire
          key={i}
          name={`l2-spire-${i}`}
          position={[s.x, SPIRE_BASE, s.z]}
          height={s.top - SPIRE_BASE}
          radius={s.radius}
          taper={s.taper ?? 0.62}
          lean={s.lean ?? 0}
          strata={11}
          below={20}
          seed={s.seed}
          segments={28}
        />
      ))}
    </group>
  );
}
