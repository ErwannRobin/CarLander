/**
 * Level 3 — THE INVERTED RAMP: monumental night-arena scenery (visual only, no physics).
 *
 * Composition, all derived from the level geometry (src/game/levels/level3/geometry.ts):
 *  - start island: apron underside, start gantry, stadium light tower, corner floodlights, facility sign
 *  - arena island: stepped underside, grandstands with red tier LEDs, floodlight masts, red LED floor
 *    lines, cyan guide chevrons in the approach lane, lattice towers framing the crescent with a red-lit
 *    gantry, and a cable-stayed mast that "holds" the inverted beam
 *  - landing island: landing lights on the beam tip, hill floodlight towers rising from the clouds
 *  - backdrop: distant panelled monoliths and truss towers with red aviation lights
 * Real lights (kit budget, high = 6, granted in mount order): start tower, two crescent floods,
 * release flood, landing-ramp flood, landing lights on the beam tip. Everything else is emissive
 * (lenses, LEDs, glow sprites, beam cones) plus additive glow pools on the beam; lower presets swap
 * the missing lights for glow pools (LightFallbacks).
 */
import { Vector3 } from 'three';
import { L3_GEO } from '@/game/levels/level3/geometry';
import { frameAt } from '@/game/track/TrackPath';
import type { V3 } from '@/game/types';
import {
  Billboard,
  CableStays,
  FacilityBase,
  Floodlight,
  Grandstand,
  kitLightBudget,
  LEDStrip,
  LightRig,
  Monolith,
  TrussBeam,
  TrussTower,
} from '@/render/level';
import { LaneChevrons } from './level3/LaneChevrons';
import { SurfaceGlow } from './level3/SurfaceGlow';

const G = L3_GEO;
const P = G.params;
const v3 = (p: Vector3): V3 => [p.x, p.y, p.z];

// ---- key positions ----------------------------------------------------------------------------
const START_TOP = G.start.topY;
const START_Z0 = G.start.center[2] + G.start.size[2] / 2; // back edge (+z)
const START_Z1 = G.start.center[2] - G.start.size[2] / 2; // front edge
const ARENA_TOP = G.arena.topY;
const ARENA_Z0 = G.arena.center[2] + G.arena.size[2] / 2; // front edge (towards the start)
const ARENA_Z1 = G.arena.center[2] - G.arena.size[2] / 2; // back edge
const ARENA_HX = G.arena.size[0] / 2;
const DECK_LEN = G.deck[G.deck.length - 1].s;
const ENTRY = G.deck[G.deck.length - 1].position; // crescent entry (bottom of the quarter pipe)
const WALL_Z = ENTRY.z - P.pipeRadius; // vertical wall plane
const RELEASE_MID = frameAt(G.crescent, (G.releaseStart + G.releaseEnd) / 2);
const TARGET = frameAt(G.hill, G.outrunStart * 0.42);

/** Beam back-side anchor (top of the truss arm) at beam arc length `s` (from the inverted start). */
function beamAnchor(s: number): V3 {
  const f = frameAt(G.crescent, G.invertedStart + s);
  // the beam's drive side faces down: its back (truss arm) is opposite to the frame up
  return v3(f.position.clone().addScaledVector(f.up, -6.2));
}

/** Drive-surface point of the inverted beam at beam arc length `s`. */
function beamPoint(s: number): V3 {
  return v3(frameAt(G.crescent, G.invertedStart + s).position);
}

/** Point beside the hill at arc length s, `side` meters to the right (+) / left (−), at height dy. */
function besideHill(s: number, side: number, dy = 0): Vector3 {
  const f = frameAt(G.hill, s);
  const right = new Vector3(f.right.x, 0, f.right.z).normalize();
  return f.position.clone().addScaledVector(right, side).add(new Vector3(0, dy, 0));
}

// ---- start island ------------------------------------------------------------------------------

function StartIsland() {
  const cz = G.start.center[2];
  return (
    <group name="l3-start-island">
      <FacilityBase position={[0, START_TOP - G.start.size[1], cz]} size={[G.start.size[0], G.start.size[2]]} depth={38} steps={3} />
      {/* start gantry over the runway (emissive lamps) */}
      <LightRig
        position={[0, START_TOP, P.spawnZ - 22]}
        width={P.runwayWidth + 12}
        height={13}
        count={8}
        aim={[0, 0, P.spawnZ + 6]}
        lights={0}
      />
      {/* stadium light tower behind the start: one real light covers spawn → kicker lip */}
      <Floodlight
        position={[-22, START_TOP, START_Z0 - 3]}
        height={40}
        aim={[0, 0, P.spawnZ - 38]}
        lenses={[5, 3]}
        lensSize={0.5}
        light={{ angle: 0.36, intensity: 2.4 * 85 * 85 * 1.5, distance: 260 }}
        beam={0.025}
      />
      <Floodlight position={[-34, START_TOP, START_Z0 - 4]} height={22} aim={[0, 0, P.spawnZ - 40]} lenses={[3, 2]} />
      <Floodlight position={[34, START_TOP, START_Z0 - 4]} height={22} aim={[0, 0, P.spawnZ - 40]} lenses={[3, 2]} />
      <Billboard
        position={[-28, START_TOP, START_Z1 + 6]}
        text="INVERTED RAMP"
        subtitle="Vacuum adhesion trial · Arena 03"
        tag="L3"
        width={16}
        height={4.4}
        postHeight={4}
      />
    </group>
  );
}

// ---- arena island ------------------------------------------------------------------------------

function ArenaIsland() {
  const cz = G.arena.center[2];
  const standLen = Math.min(110, G.arena.size[2] - 40);
  const standX = ARENA_HX - 19;
  const mastX = ARENA_HX - 5;
  const crescentAim: V3 = [0, ARENA_TOP + 26, ENTRY.z - 34];
  const wallAim: V3 = [0, ARENA_TOP + 62, WALL_Z + 8];
  const ledY = ARENA_TOP + 0.04;
  const laneHalf = P.deckWidth / 2 + 3;
  const lineX = 30;
  const towerX = 32;
  const towerZ = WALL_Z - 12;
  const towerH = G.crescentHeight + 10;
  const mastZ = WALL_Z - 50;
  const mastTop = ARENA_TOP + G.crescentHeight * 1.62;
  return (
    <group name="l3-arena-island">
      <FacilityBase position={[0, ARENA_TOP - G.arena.size[1], cz]} size={[G.arena.size[0], G.arena.size[2]]} depth={66} steps={3} />
      <Grandstand position={[-standX, ARENA_TOP, cz + 6]} rotation={[0, Math.PI / 2, 0]} length={standLen} rows={16} />
      <Grandstand position={[standX, ARENA_TOP, cz + 6]} rotation={[0, -Math.PI / 2, 0]} length={standLen} rows={16} />
      {/* floodlight masts: the front pair lights the crescent face (real lights), the back pair is emissive */}
      <Floodlight
        position={[-mastX, ARENA_TOP, ARENA_Z0 - 6]}
        height={34}
        aim={crescentAim}
        lenses={[4, 2]}
        light={{ angle: 0.5, intensity: 2.4 * 90 * 90 * 1.6 }}
        beam={0.035}
      />
      <Floodlight
        position={[mastX, ARENA_TOP, ARENA_Z0 - 6]}
        height={34}
        aim={wallAim}
        lenses={[4, 2]}
        light={{ angle: 0.48, intensity: 2.4 * 100 * 100 * 1.6 }}
        beam={0.035}
      />
      <Floodlight position={[-mastX, ARENA_TOP, ARENA_Z1 + 6]} height={30} aim={[0, ARENA_TOP + 30, ENTRY.z]} lenses={[3, 2]} />
      <Floodlight position={[mastX, ARENA_TOP, ARENA_Z1 + 6]} height={30} aim={[0, ARENA_TOP + 30, ENTRY.z]} lenses={[3, 2]} />
      {/* ground flood under the beam end: lights the inverted car through the RELEASE zone */}
      <Floodlight
        position={[RELEASE_MID.position.x + 14, ARENA_TOP, ARENA_Z0 - 4]}
        height={6}
        aim={v3(RELEASE_MID.position.clone().add(new Vector3(0, 2, 6)))}
        lenses={[3, 2]}
        light={{ angle: 0.34, intensity: 2.4 * 110 * 110 * 1.4 }}
      />
      {/* landing-ramp flood (aerial approach touchdown) from the arena's front-left corner */}
      <Floodlight
        position={[-ARENA_HX + 22, ARENA_TOP, ARENA_Z0 - 3]}
        height={16}
        aim={v3(frameAt(G.deck, 40).position)}
        lenses={[3, 2]}
        light={{ angle: 0.45, intensity: 2.4 * 75 * 75 * 1.3 }}
      />
      {/* red LED floor lines (kept clear of the lane) */}
      <LEDStrip points={[[-lineX, ledY, ARENA_Z0 - 10], [-lineX, ledY, ARENA_Z1 + 10]]} color="red" width={0.3} spill={1.6} />
      <LEDStrip points={[[lineX, ledY, ARENA_Z0 - 10], [lineX, ledY, ARENA_Z1 + 10]]} color="red" width={0.3} spill={1.6} />
      <LEDStrip points={[[-ARENA_HX + 10, ledY, ARENA_Z0 - 10], [-laneHalf, ledY, ARENA_Z0 - 10]]} color="red" width={0.3} spill={1.6} />
      <LEDStrip points={[[laneHalf, ledY, ARENA_Z0 - 10], [ARENA_HX - 10, ledY, ARENA_Z0 - 10]]} color="red" width={0.3} spill={1.6} />
      <LEDStrip points={[[-ARENA_HX + 10, ledY, mastZ + 12], [ARENA_HX - 10, ledY, mastZ + 12]]} color="red" width={0.3} spill={1.6} />
      {/* cyan guide chevrons in the approach lane, pointing at the crescent entry */}
      <LaneChevrons frames={G.deck} at={[DECK_LEN - 8, DECK_LEN - 17, DECK_LEN - 26]} span={6} depth={2.6} bar={0.28} intensity={0.42} />
      {/* lattice towers framing the crescent + red-lit gantry behind its top */}
      <TrussTower position={[-towerX, ARENA_TOP, towerZ]} height={towerH} width={7} depth={7} topLights="red" />
      <TrussTower position={[towerX, ARENA_TOP, towerZ]} height={towerH} width={7} depth={7} topLights="red" />
      <TrussBeam
        from={[-towerX, ARENA_TOP + towerH - 1.5, towerZ]}
        to={[towerX, ARENA_TOP + towerH - 1.5, towerZ]}
        width={3}
        height={3}
        ledColor="red"
      />
      {/* floods on the arena floor washing the inverted beam's drive surface (emissive + glow pools) */}
      <Floodlight position={[24, ARENA_TOP, ARENA_Z0 - 24]} height={5} aim={beamPoint(30)} lenses={[3, 2]} beam={0.045} />
      <Floodlight position={[44, ARENA_TOP, ARENA_Z0 - 6]} height={5} aim={beamPoint(70)} lenses={[3, 2]} beam={0.045} />
      <SurfaceGlow
        frames={G.crescent}
        pools={[
          { s: G.invertedStart + 30, halfLength: 24, halfWidth: P.crescentWidth / 2 + 1 },
          { s: G.invertedStart + 70, halfLength: 24, halfWidth: P.crescentWidth / 2 + 1, strength: 0.9 },
        ]}
        intensity={0.5}
      />
      {/* cable-stayed mast holding the inverted beam (cables run above the beam's truss arm) */}
      <CableStays
        anchor={[0, mastTop, mastZ]}
        mastBase={[0, ARENA_TOP, mastZ]}
        mastWidth={4.2}
        radius={0.16}
        points={[24, 48, 72, 96, 118].map(beamAnchor)}
      />
    </group>
  );
}

// ---- landing island ----------------------------------------------------------------------------

function LandingIsland() {
  const end = G.beamEnd;
  const outer = new Vector3(end.right.x, 0, end.right.z).normalize();
  const tip = end.position.clone().addScaledVector(outer, P.crescentWidth / 2 + 2.5).add(new Vector3(0, 1.5, 0));
  const base = -260;
  const towerA = besideHill(60, -(P.hillWidth / 2 + 16));
  const towerB = besideHill(150, P.hillWidth / 2 + 16);
  const hA = TARGET.position.y + 26 - base;
  const hB = besideHill(150, 0).y + 30 - base;
  return (
    <group name="l3-landing-island">
      {/* landing lights on the beam tip, aimed down the hill at the target */}
      <Floodlight
        position={[tip.x, tip.y, tip.z]}
        height={0}
        mast={false}
        aim={v3(TARGET.position)}
        lenses={[3, 2]}
        light={{ angle: 0.36, intensity: 2.4 * 95 * 95 * 1.5 }}
      />
      {/* floodlight towers rising from the cloud sea beside the hill */}
      <TrussTower position={[towerA.x, base, towerA.z]} height={hA} width={6} depth={6} topLights="red" castShadow={false} />
      <Floodlight position={[towerA.x, base + hA, towerA.z]} height={0} mast={false} aim={v3(TARGET.position)} lenses={[4, 2]} />
      <TrussTower position={[towerB.x, base, towerB.z]} height={hB} width={6} depth={6} topLights="red" castShadow={false} />
      <Floodlight position={[towerB.x, base + hB, towerB.z]} height={0} mast={false} aim={v3(besideHill(120, 0))} lenses={[4, 2]} />
    </group>
  );
}

// ---- backdrop ----------------------------------------------------------------------------------

function Backdrop() {
  return (
    <group name="l3-backdrop">
      <Monolith position={[-330, -420, -520]} size={[36, 640, 36]} variant="graphite" seams={2} bands={2} seamColor="red" />
      <Monolith position={[-430, -420, -160]} size={[28, 560, 28]} variant="warm" seams={1} bands={1} />
      <Monolith position={[330, -420, -600]} size={[32, 600, 42]} variant="warm" seams={1} bands={1} />
      <Monolith position={[520, -420, -120]} size={[26, 540, 26]} variant="graphite" seams={2} bands={1} seamColor="red" />
      <TrussTower position={[-170, -300, -620]} height={430} width={10} depth={10} topLights="red" castShadow={false} />
      <TrussTower position={[150, -300, -700]} height={410} width={10} depth={10} topLights="red" castShadow={false} />
      <TrussTower position={[-420, -300, -300]} height={400} width={10} depth={10} topLights="red" castShadow={false} />
    </group>
  );
}

/**
 * Lower quality presets grant fewer real lights (kit budget: high 6 / medium 3 / low 0, handed out in
 * mount order: start tower, crescent left, crescent right, release flood, landing-ramp flood, landing
 * lights). Every fixture that does not get a slot is replaced by a soft glow pool on its target
 * surface, so the key surfaces stay readable at night on every preset.
 */
function LightFallbacks({ budget }: { budget: number }) {
  if (budget >= 6) return null;
  const hw = (w: number) => w / 2 + 1;
  return (
    <group name="l3-light-fallbacks">
      <SurfaceGlow
        frames={G.hill}
        pools={[{ s: G.outrunStart * 0.42, halfLength: 34, halfWidth: hw(P.hillWidth) }]}
        intensity={0.55}
      />
      {budget < 5 && <SurfaceGlow frames={G.deck} pools={[{ s: 40, halfLength: 34, halfWidth: hw(P.deckWidth) }]} intensity={0.45} />}
      {budget < 4 && (
        <SurfaceGlow
          frames={G.crescent}
          pools={[{ s: (G.releaseStart + G.releaseEnd) / 2, halfLength: 22, halfWidth: hw(P.crescentWidth) }]}
          intensity={0.55}
        />
      )}
      {budget < 3 && (
        <SurfaceGlow
          frames={G.crescent}
          pools={[{ s: P.pipeRadius * 1.9, halfLength: 34, halfWidth: hw(P.crescentWidth) }]}
          intensity={0.6}
        />
      )}
      {budget < 2 && (
        <SurfaceGlow frames={G.crescent} pools={[{ s: P.pipeRadius * 0.6, halfLength: 30, halfWidth: hw(P.crescentWidth) }]} intensity={0.6} />
      )}
      {budget < 1 && (
        <SurfaceGlow
          frames={G.runway}
          pools={[{ s: P.runwayStartZ - P.spawnZ + 30, halfLength: 55, halfWidth: hw(P.runwayWidth) }]}
          intensity={0.4}
        />
      )}
    </group>
  );
}

export function Level3Decor() {
  // GameScene remounts the decor when the quality preset changes, so the budget is read once
  const budget = kitLightBudget();
  return (
    <group name="level3-decor">
      <StartIsland />
      <ArenaIsland />
      <LandingIsland />
      <Backdrop />
      <LightFallbacks budget={budget} />
    </group>
  );
}
