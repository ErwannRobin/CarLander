/**
 * LEVEL 3 — THE INVERTED RAMP: track geometry (pure data, shared by the LevelDef, the reference
 * pilot, the tests and the decor).
 *
 * Layout (top view, the run starts heading −Z):
 *
 *   start apron ─ runway ─ kicker 17.7° ─ void 30 m ─ landing ramp ─ arena (lane) ─ crescent
 *                                                                                  │ quarter pipe R46
 *                                                                                  │ vertical wall 4 m
 *                                                                                  │ overhang R36 (86 m)
 *   outrun ─ ski-jump landing hill ◄─ RELEASE ─ inverted beam (130 m, curving right) ◄┘ back over
 *                                                                                  the arena
 *
 * Every piece is built with TrackPath so render and physics share the exact same frames. The
 * landing ramp and the landing hill follow ballistic envelopes tuned with headless sweeps:
 *  - the aerial approach lands CLEAN from ≈ 27 m/s at the lip up to full throttle (≈ 37 m/s);
 *  - full throttle reaches the crescent at ≈ 48 m/s (faint grazes at most) and the RELEASE zone at
 *    ≈ 48 m/s; releases anywhere in the zone from ≈ 30 m/s to full throttle land CLEAN or better,
 *    and full-throttle releases in the middle of the zone are PERFECT-able.
 */
import { Vector3 } from 'three';
import { frameAt, TrackPath } from '../../track/TrackPath';
import type { TrackFrame, V3 } from '../../types';

const DEG = Math.PI / 180;

export interface L3Params {
  /** Spawn: z of the car on the start runway and its initial speed (m/s). */
  spawnZ: number;
  spawnSpeed: number;
  /** Runway start z (behind the spawn), flat length, then an uphill run-up [deg, transition radius, straight length]. */
  runwayStartZ: number;
  runwayLength: number;
  runwaySlopeDeg: number;
  runwaySlopeRadius: number;
  runwaySlopeLength: number;
  runwayWidth: number;
  /** Absolute launch angle at the lip (deg). */
  kickerDeg: number;
  kickerRadius: number;
  kickerLip: number;
  /** Horizontal gap from the lip to the landing ramp, and how far the ramp top sits below the lip. */
  gap: number;
  deckDrop: number;
  /** Landing ramp: start pitch (deg, negative = down), successive down() steps [deg, length], transition radius back to flat. */
  rampStartPitch: number;
  rampSteps: [number, number][];
  rampTransitionRadius: number;
  /** Flat approach lane up to the crescent entry. */
  laneLength: number;
  deckWidth: number;
  /** Crescent: quarter pipe radius, vertical wall, overhang radius, drive width. */
  pipeRadius: number;
  wall: number;
  overhangRadius: number;
  crescentWidth: number;
  /** Inverted beam: straight, right curve (deg / radius), final straight. */
  beamStraight: number;
  beamCurveDeg: number;
  beamCurveRadius: number;
  beamFinal: number;
  /** Release zone length and its distance from the beam end (m). */
  releaseLength: number;
  releaseMargin: number;
  /** Landing hill: offset of its top from the beam end (along the release heading / below the beam surface). */
  hillAhead: number;
  hillBelow: number;
  /** Landing hill profile: start pitch (deg, negative = down) and successive down() steps [deg, length]. */
  hillStartPitch: number;
  hillSteps: [number, number][];
  /** Concave transition radius into the outrun and outrun length. */
  hillTransitionRadius: number;
  outrunLength: number;
  hillWidth: number;
  /** Arena floor (box) around the crescent base: width, extra length behind the crescent. */
  arenaWidth: number;
  arenaBehind: number;
}

export const L3_DEFAULTS: L3Params = {
  spawnZ: 0,
  spawnSpeed: 10,
  runwayStartZ: 40,
  runwayLength: 100,
  runwaySlopeDeg: 0,
  runwaySlopeRadius: 150,
  runwaySlopeLength: 0,
  runwayWidth: 24,
  kickerDeg: 17.7,
  kickerRadius: 60,
  kickerLip: 2,
  gap: 30,
  deckDrop: 1,
  rampStartPitch: -0.2,
  rampSteps: [
    [4.2, 16.65],
    [4.7, 16.65],
    [4.2, 16.65],
  ],
  rampTransitionRadius: 120,
  laneLength: 40,
  deckWidth: 26,
  pipeRadius: 46,
  wall: 4,
  overhangRadius: 36,
  crescentWidth: 18,
  beamStraight: 12,
  beamCurveDeg: 30,
  beamCurveRadius: 160,
  beamFinal: 34,
  releaseLength: 24,
  releaseMargin: 2,
  hillAhead: 3.8,
  hillBelow: 9.3,
  hillStartPitch: -2,
  hillSteps: [
    [12.7, 52],
    [8.9, 38.5],
    [3.1, 34.2],
    [-1.7, 24.3],
  ],
  hillTransitionRadius: 170,
  outrunLength: 210,
  hillWidth: 36,
  arenaWidth: 150,
  arenaBehind: 70,
};

export interface L3Geometry {
  params: L3Params;
  runway: TrackFrame[];
  kicker: TrackFrame[];
  /** Landing ramp + approach lane (ends exactly where the crescent starts). */
  deck: TrackFrame[];
  /** Crescent: quarter pipe → wall → overhang → inverted beam (one ribbon). */
  crescent: TrackFrame[];
  /** Landing hill + outrun. */
  hill: TrackFrame[];
  lip: TrackFrame;
  /** Arc length (on `deck`) where the landing ramp ends (start of the flat approach lane). */
  rampLength: number;
  /** Arc length (on `crescent`) where the car is fully inverted (beam start) and the beam length. */
  invertedStart: number;
  beamLength: number;
  /** Arc length (on `crescent`) of the release zone start / end, and of the crescent end. */
  releaseStart: number;
  releaseEnd: number;
  crescentLength: number;
  beamEnd: TrackFrame;
  /** Horizontal unit heading of the release (beam end forward, flattened). */
  releaseHeading: Vector3;
  /** Arc length (on `hill`) where the steep part ends and the outrun starts. */
  outrunStart: number;
  /** Height of the crescent top above the arena floor (m). */
  crescentHeight: number;
  /** Arena floor box (top surface 5 cm under the approach lane). */
  arena: { center: V3; size: V3; topY: number };
  /** Start apron box around the spawn (top surface 5 cm under the runway). */
  start: { center: V3; size: V3; topY: number };
}

export function yawOf(dir: Vector3): number {
  return Math.atan2(-dir.x, -dir.z) / DEG;
}

export function v3(p: Vector3): V3 {
  return [p.x, p.y, p.z];
}

export function buildL3Geometry(p: L3Params = L3_DEFAULTS): L3Geometry {
  // ---- start runway + kicker ----
  const runway = new TrackPath({ position: [0, 0, p.runwayStartZ] }).straight(p.runwayLength);
  if (p.runwaySlopeDeg > 0) runway.up(p.runwaySlopeDeg, p.runwaySlopeRadius).straight(p.runwaySlopeLength);
  const kicker = TrackPath.fromFrame(runway.end())
    .up(p.kickerDeg - p.runwaySlopeDeg, p.kickerRadius)
    .straight(p.kickerLip);
  const lip = kicker.end();

  // ---- landing ramp (progressive downslope) → transition → flat approach lane ----
  const deckTop = lip.position.y - p.deckDrop;
  const deckStartZ = lip.position.z - p.gap;
  const deck = new TrackPath({ position: [0, deckTop, deckStartZ], pitchDeg: p.rampStartPitch });
  let rampPitch = -p.rampStartPitch;
  for (const [deg, len] of p.rampSteps) {
    deck.curve({ pitchDeg: -deg, length: len });
    rampPitch += deg;
  }
  deck.up(rampPitch, p.rampTransitionRadius);
  const rampLength = deck.length;
  deck.straight(p.laneLength);
  const laneY = deck.end().position.y;

  // ---- crescent: quarter pipe → vertical wall → overhang → inverted beam ----
  const climb = TrackPath.fromFrame(deck.end())
    .up(90, p.pipeRadius)
    .straight(p.wall)
    .up(90, p.overhangRadius);
  const invertedStart = climb.length;
  const crescent = climb.straight(p.beamStraight).right(p.beamCurveDeg, p.beamCurveRadius).straight(p.beamFinal);
  const crescentLength = crescent.length;
  const beamLength = crescentLength - invertedStart;
  const beamEnd = crescent.end();
  const releaseEnd = crescentLength - p.releaseMargin;
  const releaseStart = releaseEnd - p.releaseLength;
  const releaseHeading = new Vector3(beamEnd.forward.x, 0, beamEnd.forward.z).normalize();

  // ---- ski-jump landing hill + outrun ----
  const hillTop = beamEnd.position
    .clone()
    .addScaledVector(releaseHeading, p.hillAhead)
    .add(new Vector3(0, -p.hillBelow, 0));
  const hill = new TrackPath({ position: hillTop, yawDeg: yawOf(releaseHeading), pitchDeg: p.hillStartPitch });
  let pitch = -p.hillStartPitch;
  for (const [deg, len] of p.hillSteps) {
    hill.curve({ pitchDeg: -deg, length: len });
    pitch += deg;
  }
  hill.up(pitch, p.hillTransitionRadius);
  const outrunStart = hill.length;
  hill.straight(p.outrunLength);

  // ---- arena floor: from the end of the landing ramp to behind the crescent tower ----
  const front = frameAt(deck.frames, rampLength).position.z;
  const back = deck.end().position.z - p.pipeRadius - p.arenaBehind;
  const topY = laneY - 0.05;
  const thickness = 4;
  const arena = {
    center: [0, topY - thickness / 2, (front + back) / 2] as V3,
    size: [p.arenaWidth, thickness, front - back] as V3,
    topY,
  };

  // ---- start apron: a wide floating platform around the spawn (the runway continues as a bridge) ----
  const startFront = p.spawnZ - 25;
  const startBack = p.runwayStartZ + 5;
  const start = {
    center: [0, -0.05 - thickness / 2, (startFront + startBack) / 2] as V3,
    size: [80, thickness, startBack - startFront] as V3,
    topY: -0.05,
  };

  return {
    params: p,
    runway: runway.frames,
    kicker: kicker.frames,
    deck: deck.frames,
    crescent: crescent.frames,
    hill: hill.frames,
    lip,
    rampLength,
    invertedStart,
    beamLength,
    releaseStart,
    releaseEnd,
    crescentLength,
    beamEnd,
    releaseHeading,
    outrunStart,
    crescentHeight: p.pipeRadius + p.wall + p.overhangRadius,
    arena,
    start,
  };
}

/** The level's geometry (built once, shared by the LevelDef, the pilot and the decor). */
export const L3_GEO: L3Geometry = buildL3Geometry();
