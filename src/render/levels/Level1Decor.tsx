/**
 * Level 1 — LEARN TO FLY: monumental scenery (render only; gameplay pieces live in the LevelDef).
 *
 * A pristine test facility at dawn, suspended above the cloud sea:
 *  - a grand gateway over the runway (towers plunging into the clouds, cable-stay fans), placed so the
 *    car drives through it right after the intro and early in every restart
 *  - distance boards counting down to the kicker, slim cyan beacons at the lip
 *  - needle masts with stay fans at the funnel; tall beacons carrying a TARGET gate above the start
 *    of the rings and edge posts along them (they rise above the apron crest, so the landing area
 *    reads from the lip: land between the TARGET gate and the FINISH arch — a zone marker)
 *  - the monumental facility beyond the finish deck and lone megastructures in the cloud sea
 * Everything is placed from the level geometry (L1) and stays outside the drive / flight envelope.
 */
import { useMemo } from 'react';
import { L1 } from '@/game/levels/level1';
import type { V3 } from '@/game/types';
import { Gateway } from './level1/Gateway';
import { Beacons, DistanceBoards, EdgePosts, TargetGate, type Beacon, type DistanceBoard, type EdgePost } from './level1/Markers';
import { Facility, Needles, RunwayPiers, StartPlaza, StayMasts, type StayMast } from './level1/Skyline';

/** World z of the runway start (z = 0) going toward −Z: runway arc length s ↔ z = −s. */
const zOfRunway = (s: number) => L1.runwayStartZ - s;

function useCourse() {
  return useMemo(() => {
    const p = L1.params;
    const kickerZ = L1.runwayEndZ;
    const lip = L1.lip.position;
    const halfAt = (z: number) => L1.runwayWidthAt(L1.runwayStartZ - z) / 2;

    const boards: DistanceBoard[] = [300, 200, 100].map((d) => ({ z: kickerZ + d, text: String(d), halfWidth: halfAt(kickerZ + d) }));

    const deckHalf = p.deckWidth / 2;
    const tStart = L1.deck.at(L1.targetS.start).position;
    const beacons: Beacon[] = [
      // the lip
      { base: [-(p.kickerWidth / 2 + 3.5), lip.y - 95, lip.z], top: lip.y + 12.5, radius: 0.5 },
      { base: [p.kickerWidth / 2 + 3.5, lip.y - 95, lip.z], top: lip.y + 12.5, radius: 0.5 },
      // the start of the rings
      { base: [-(deckHalf + 4.5), tStart.y - 120, tStart.z], top: tStart.y + 25, radius: 0.75 },
      { base: [deckHalf + 4.5, tStart.y - 120, tStart.z], top: tStart.y + 25, radius: 0.75 },
    ];

    const posts: EdgePost[] = [];
    for (let s = L1.targetS.start + 15; s < L1.targetS.end - 4; s += 15) {
      const f = L1.deck.at(s);
      for (const side of [-1, 1]) posts.push({ at: f.position.clone().addScaledVector(f.right, side * (deckHalf + 0.75)), up: f.up.clone() });
    }

    const masts: StayMast[] = [];
    // needle masts at the funnel, stays carrying the end of the runway
    const funnelZ = kickerZ + 40;
    const funnelHalf = halfAt(funnelZ);
    masts.push(
      ...[-1, 1].map((side) => ({
        x: side * (funnelHalf + 10),
        z: funnelZ,
        foot: -185,
        head: 30,
        anchors: [-24, -12, 12, 24, 36].map((dz) => {
          const z = funnelZ + dz;
          return [side * (halfAt(z) + 0.3), -0.75, z] as V3;
        }),
      })),
    );

    const finish = L1.deck.end().position;
    const facility: V3 = [0, finish.y - 8, finish.z - 205];

    // very slender far masts in the cloud sea: scale and depth without clutter
    const needles = [
      { x: -560, z: -760, top: 120, radius: 3.2 },
      { x: -640, z: -820, top: 64, radius: 2.4 },
      { x: 720, z: -1240, top: 150, radius: 3.6 },
      { x: 430, z: 260, top: 96, radius: 2.8 },
    ];

    // runway piers (auto supports are off on the runway): a slower rhythm around the gateway
    const piers = [-16, -78, -205, -268, -332].map((z) => ({ z, deckWidth: halfAt(z) * 2 }));

    const gate: V3 = [0, tStart.y + 20.4, tStart.z];
    const gateSpan = (deckHalf + 4.5) * 2;

    return { boards, beacons, posts, masts, facility, needles, gate, gateSpan, piers, gatewayZ: zOfRunway(140), gatewayHalf: halfAt(zOfRunway(140)) };
  }, []);
}

export function Level1Decor() {
  const c = useCourse();
  return (
    <group name="level1-decor">
      <StartPlaza />
      <RunwayPiers piers={c.piers} />
      <Gateway z={c.gatewayZ} halfWidth={c.gatewayHalf} />
      <DistanceBoards boards={c.boards} />
      <Beacons beacons={c.beacons} />
      <EdgePosts posts={c.posts} />
      <TargetGate center={c.gate} span={c.gateSpan} />
      <StayMasts masts={c.masts} />
      <Facility position={c.facility} />
      <Needles items={c.needles} />
    </group>
  );
}
