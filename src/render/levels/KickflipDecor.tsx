/**
 * Level 2 — KICKFLIP scenery (night show, after Tesla's "The Kickflip"): the five-vehicle lineup in
 * the gap (collision blocks live in the LevelDef), a red LED strip along the lineup, and beacons at
 * the lip and at the start of the landing rings.
 */
import { KF, KF_CARS, KF_GAP_MID_Z, KF_LOT_Y } from '@/game/levels/kickflip/layout';
import type { Beacon } from './level1/Markers';
import { Beacons } from './level1/Markers';
import { Lineup } from './kickflip/Lineup';

export function KickflipDecor() {
  const lip = KF.lip.position;
  const t = KF.deck.at(KF.targetS.start).position;
  const kw = KF.params.kickerWidth / 2 + 3;
  const dw = KF.params.deckWidth / 2 + 4;
  const beacons: Beacon[] = [
    { base: [-kw, lip.y - 95, lip.z], top: lip.y + 10, radius: 0.5 },
    { base: [kw, lip.y - 95, lip.z], top: lip.y + 10, radius: 0.5 },
    { base: [-dw, t.y - 120, t.z], top: t.y + 20, radius: 0.7 },
    { base: [dw, t.y - 120, t.z], top: t.y + 20, radius: 0.7 },
  ];
  const first = KF_CARS[0].position[2] + KF_CARS[0].size[2] / 2;
  const last = KF_CARS[KF_CARS.length - 1].position[2] - KF_CARS[KF_CARS.length - 1].size[2] / 2;
  const stripLen = first - last + 4;
  return (
    <group>
      <Lineup vehicles={KF_CARS} />
      {/* show lighting: cool spots from both sides and a warm key from above the lineup */}
      <pointLight position={[0, 14, KF_GAP_MID_Z]} intensity={260} distance={40} decay={2} color="#fff1e0" />
      <pointLight position={[-10, 6, KF_GAP_MID_Z]} intensity={140} distance={30} decay={2} color="#8fc8ff" />
      <pointLight position={[10, 6, KF_GAP_MID_Z]} intensity={140} distance={30} decay={2} color="#8fc8ff" />
      {/* glowing red LED strips in front of and behind the lineup */}
      {[-1, 1].map((side) => (
        <mesh key={side} position={[side * 4.2, KF_LOT_Y + 0.06, KF_GAP_MID_Z]}>
          <boxGeometry args={[0.18, 0.1, stripLen]} />
          <meshBasicMaterial color="#ff2b3d" toneMapped={false} />
        </mesh>
      ))}
      <Beacons beacons={beacons} />
    </group>
  );
}
