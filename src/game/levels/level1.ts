/**
 * LEVEL 1 — LEARN TO FLY (theme 'morning').
 *
 * A pristine test facility at dawn: a 380 m runway (26 m wide, funnel to 16 m) → a 17° kicker →
 * a 75 m open gap above the clouds → a long landing deck: a table at lip height (the apron), a
 * crest, then a landing slope steepening from 12° to 16° that carries the huge target rings, an
 * outrun and the flat finish deck.
 *
 * Why a landing slope and not a flat deck: at full throttle the car leaves the lip at ≈ 55 m/s and a
 * burn takes it to the 80 m/s cap; any flat deck below the lip is met at 17–30 m/s of vertical speed
 * (HARD / crash). The slope steepens with distance because longer burns fly farther, higher and
 * faster, so every burn length meets the deck at a shallow relative angle (CLEAN, PERFECT with an
 * apex burn).
 *
 * Tuned with tests/levels/level1.test.ts (sweeps of run-up speed, burn start/duration, stabilizer):
 *  - full throttle, no thrust → lands on the apron (≈ 130 m from the lip), HARD but safe, short of
 *    the target → retry advice;
 *  - full throttle + any burn of ≥ 0.3 s started 0–1.2 s after the lip (the whole 0.75 s tank
 *    included) → in the target, CLEAN in most of that window, PERFECT with an apex burn.
 * Readability: a soft-landing slope is tangent to the trajectory, so it is never visible from the
 * lip; the decor frames it instead (beacons + TARGET gate above the start of the rings, the FINISH
 * arch zone marker at their far end), plus the x-ray landing reticle and the intro.
 * Finish: a landing of at least HARD inside the target (forgiving: the score and medal reward
 * CLEAN / PERFECT, the tutorial never blocks a surviving landing in the rings).
 */
import { Vector3 } from 'three';
import type { Autopilot } from '../sim/autopilot';
import type { LevelDef, V3, ZoneDef } from '../types';
import { createL1Flow, createL1Hints, L1_ZONE } from './level1/flow';
import { buildL1Layout, deckSlopeAt, type L1Layout } from './level1/layout';
import { createL1Pilot, type L1PilotOptions } from './level1/pilot';

const v3 = (p: Vector3): V3 => [p.x, p.y, p.z];

/** The level's geometry (exported for the decor, the pilot and the tests). */
export const L1: L1Layout = buildL1Layout();

const lip = L1.lip;
const kickerMid = L1.kicker.at(L1.kicker.length / 2);
const targetCenter = L1.deck.at(L1.targetS.center);
const targetSlope = deckSlopeAt(L1, L1.targetS.center);
const targetStartZ = L1.deck.at(L1.targetS.start).position.z;
const targetEndZ = L1.deck.at(L1.targetS.end).position.z;
const finishFrame = L1.deck.end();

const TARGET_CENTER = v3(targetCenter.position.clone().addScaledVector(targetCenter.up, 1.5));
const TARGET_HALF: V3 = [L1.params.targetHalfWidth, 8, (L1.targetS.end - L1.targetS.start) / 2];
const TARGET_ROT: V3 = [-targetSlope, 0, 0];

const ZONES: ZoneDef[] = [
  {
    // the kicker volume: the "let go at the lip" prompt shows here, the thrust burn is counted from here
    id: L1_ZONE.kicker,
    purpose: 'trigger',
    center: [0, kickerMid.position.y + 2.5, kickerMid.position.z],
    halfSize: [L1.params.kickerWidth / 2 + 0.5, 6, L1.kicker.length / 2 + 1],
    visible: false,
  },
  {
    // huge concentric rings on the landing slope; also the finish zone
    id: L1_ZONE.target,
    purpose: 'target',
    center: TARGET_CENTER,
    halfSize: TARGET_HALF,
    rotationDeg: TARGET_ROT,
    label: 'TARGET',
  },
  {
    // render-only: the FINISH arch stands at the far end of the rings (rises above the crest, so it
    // marks the landing area from mid-flight); gameplay uses the target zone above
    id: 'l1-finish-arch',
    purpose: 'finish',
    center: TARGET_CENTER,
    halfSize: TARGET_HALF,
    rotationDeg: TARGET_ROT,
    label: 'FINISH',
  },
];

const flow = createL1Flow({
  zones: ZONES,
  targetStartZ,
  targetEndZ,
  funnelZ: L1.runwayStartZ - (L1.params.runwayLength - L1.params.funnelLength),
});

const hints = createL1Hints({
  throttle: [-17.5, 4.8, -106],
  lineUp: [-15, 5, -318],
  lip: [12.5, lip.position.y + 3.5, kickerMid.position.z - 6],
  target: [0, targetCenter.position.y + 16, targetCenter.position.z - 30],
});

/** Lowest drive surface (the finish deck) → falls are judged 30 m below it, far above the cloud sea (−165). */
const KILL_Y = Math.round(finishFrame.position.y - 30);

export const LEVEL_1: LevelDef = {
  id: 1,
  name: 'LEARN TO FLY',
  subtitle: 'Morning runway',
  description:
    'A wide runway, a gentle kicker and an open gap above the clouds. Fire the thrusters after the lip, line up with the slope and settle into the rings.',
  theme: 'morning',
  spawn: { position: [0, 0.36, -30], yawDeg: 0, speed: 18 },
  killY: KILL_Y,
  vacuumEnabled: false,
  // a short burst: the whole tank (0.75 s) still lands inside the rings, from any start up to 1.2 s after the lip
  fuel: { capacity: 0.75, regenPerSec: 0.4, regenDelay: 1.2, start: 1 },
  pieces: [
    {
      // start plaza behind the spawn: the runway grows out of a facility platform (piers / underside: decor)
      kind: 'box',
      id: 'l1-start-plaza',
      center: [0, -1.6, 30],
      size: [64, 3.2, 60],
      style: 'platform',
    },
    {
      kind: 'ribbon',
      id: 'l1-runway',
      frames: L1.runway.frames,
      width: L1.runwayWidthAt,
      style: 'runway',
      adhesive: false,
      edgeLights: 'white',
      // hand-placed piers in the decor (wider rhythm, cable-stayed by the gateway and funnel masts)
      supports: false,
      label: 'RUNWAY',
    },
    {
      kind: 'ribbon',
      id: 'l1-kicker',
      frames: L1.kicker.frames,
      width: L1.params.kickerWidth,
      style: 'ramp',
      adhesive: false,
      edgeLights: 'white',
      label: 'KICKER',
    },
    {
      // the apron: a table at lip height where a jump without thrust lands (no landing marks)
      kind: 'ribbon',
      id: 'l1-apron',
      frames: L1.apronFrames,
      width: L1.params.deckWidth,
      thickness: 1.6,
      style: 'platform',
      adhesive: false,
      edgeLights: 'cyan',
      label: 'APRON',
    },
    {
      kind: 'ribbon',
      id: 'l1-hill',
      frames: L1.hillFrames,
      width: L1.params.deckWidth,
      thickness: 1.6,
      style: 'landing',
      adhesive: false,
      edgeLights: 'cyan',
      label: 'LANDING HILL',
    },
  ],
  zones: ZONES,
  targetZoneId: L1_ZONE.target,
  objectives: flow.objectives,
  floatingHints: hints,
  finish: { zoneId: L1_ZONE.target, minQuality: 'hard', settleTime: 1 },
  // phone: the tilt gas is ignored in the air and the stabilizer holds itself (burn ends ≈ 0.75 s)
  touchAssist: { ignorePitch: true, autoStabilize: 0.8 },
  // measured: any completion ≥ ≈ 4.2k (HARD, slow) · clean typical 5.8–7k · bullseye / PERFECT / flip ≥ 8.7k
  medals: { bronze: 3000, silver: 5600, gold: 8500 },
  // opening shot down the whole course axis from behind the start: runway, gateway, kicker, the
  // landing area framed by its beacons and FINISH arch, the facility beyond; the camera swoops into
  // the chase view as the car drives through the gateway.
  // (The rig fast-forwards the intro ×3 while the car moves faster than 4 m/s: 10.5 s ⇒ ≈ 3.5 s.)
  intro: { from: [-30, 40, 30], lookAt: [0, -2, -560], duration: 10.5 },
};

/** Parametrized reference pilot (tests / tuning). */
export function level1PilotWith(options: L1PilotOptions = {}): Autopilot {
  return createL1Pilot({ runway: L1.runway.frames, kicker: L1.kicker.frames, deck: L1.deck.frames }, options);
}

/** Reference solution (headless completion tests and `?autopilot=1` demo runs) — a fresh pilot per call. */
export function level1Pilot(): Autopilot {
  return level1PilotWith();
}
