/**
 * Physics test levels — used by headless tests, the physics debug viewer (dev/physics.html) and as
 * stand-ins until the handcrafted levels land.
 *
 *  - TEST_FLAT:   huge flat deck (drive feel, flips from drops, crash tests)
 *  - TEST_RAMP:   runway → 18° kicker → gap → landing deck with a gentle downslope, target + finish
 *  - TEST_VACUUM: runway → quarter pipe (R 32) → short vertical → overhang (R 28) → inverted beam
 *                 (≈ 80 m, gently curving) → release → ski-jump landing hill (mirrors the L3 crescent,
 *                 ≈ 68 m tall)
 *
 * Spawn heights are chassis-origin heights (ground + 0.36); GameSim snaps the car onto the surface.
 */
import { Vector3 } from 'three';
import { createObjectiveHelpers } from '../sim/objectiveHelpers';
import { TrackPath } from '../track/TrackPath';
import type { LevelDef, TrackFrame, V3, ZoneDef } from '../types';

const DEG = Math.PI / 180;

/** Yaw (deg, 0 = −Z, +90 = −X) of a horizontal direction. */
function yawOf(dir: Vector3): number {
  return Math.atan2(-dir.x, -dir.z) / DEG;
}

function pointV3(p: Vector3): V3 {
  return [p.x, p.y, p.z];
}

/* ================================================================== */
/* TEST_FLAT                                                           */
/* ================================================================== */

const FLAT_ZONES: ZoneDef[] = [
  { id: 'flat-finish', purpose: 'finish', center: [0, 2, 0], halfSize: [1500, 4, 1500], visible: false },
];
const flatH = createObjectiveHelpers(FLAT_ZONES);

export const TEST_FLAT: LevelDef = {
  id: 1,
  name: 'TEST · FLAT',
  subtitle: 'Physics proving ground',
  description: 'A 3 km square deck for drive-feel, flip and crash tests.',
  theme: 'morning',
  spawn: { position: [0, 0.36, 1400], yawDeg: 0, speed: 0 },
  killY: -60,
  vacuumEnabled: false,
  fuel: { capacity: 6, regenPerSec: 0.6, regenDelay: 1, start: 1 },
  pieces: [{ kind: 'box', id: 'deck', center: [0, -1, 0], size: [3000, 2, 3000], style: 'platform' }],
  zones: FLAT_ZONES,
  objectives: [
    {
      id: 'flat-speed',
      title: 'TOP SPEED',
      text: 'Reach 200 km/h',
      hints: [{ keys: ['W'], label: 'Accelerate', actions: ['accelerate'] }],
      complete: (ctx) => flatH.speedKmh(ctx) >= 200,
    },
    {
      id: 'flat-land',
      title: 'STICK IT',
      text: 'Jump and land cleanly',
      hints: [{ keys: ['SHIFT'], label: 'Stabilize', actions: ['stabilize'] }],
      complete: (ctx) => flatH.landedIn(ctx, 'flat-finish', 'clean'),
    },
  ],
  floatingHints: [],
  finish: { zoneId: 'flat-finish', minQuality: 'clean', settleTime: 1 },
  medals: { bronze: 500, silver: 2000, gold: 4000 },
};

/* ================================================================== */
/* TEST_RAMP                                                           */
/* ================================================================== */

const RAMP_RUNWAY_LENGTH = 250;
const rampRunway = new TrackPath({ position: [0, 0, 0] }).straight(RAMP_RUNWAY_LENGTH);
/** 18° kicker on a 70 m radius (≈ 2.4 g at 40 m/s) plus a short straight lip. */
const rampKicker = TrackPath.fromFrame(rampRunway.end()).up(18, 70).straight(3);
const rampLip = rampKicker.end();
/** Landing deck: starts 30 m past the lip, ≈1.4 m lower; short flat, −12° downslope, run-out. */
const LAND_GAP = 30;
const LAND_SLOPE = 12;
const rampLanding = new TrackPath({
  position: [0, rampLip.position.y - 1.4, rampLip.position.z - LAND_GAP],
})
  .straight(12)
  .down(LAND_SLOPE, 60)
  .straight(52)
  .up(LAND_SLOPE, 90)
  .straight(170);
/** Target centered where a ≈ 40 m/s ballistic jump touches down (on the downslope). */
const rampTargetFrame = rampLanding.at(12 + LAND_SLOPE * DEG * 60 + 34);
const RAMP_LAND_START_Z = rampLip.position.z - LAND_GAP;
const RAMP_LAND_END_Z = rampLanding.end().position.z;

const RAMP_ZONES: ZoneDef[] = [
  {
    id: 'ramp-target',
    purpose: 'target',
    center: pointV3(rampTargetFrame.position.clone().addScaledVector(rampTargetFrame.up, 1.5)),
    halfSize: [9, 3, 16],
    rotationDeg: [-LAND_SLOPE, 0, 0],
    label: 'TARGET',
  },
  {
    id: 'ramp-finish',
    purpose: 'finish',
    center: [0, rampLanding.end().position.y + 6, (RAMP_LAND_START_Z + RAMP_LAND_END_Z) / 2],
    halfSize: [16, 16, (RAMP_LAND_START_Z - RAMP_LAND_END_Z) / 2],
    visible: false,
  },
];
const rampH = createObjectiveHelpers(RAMP_ZONES);

export const TEST_RAMP: LevelDef = {
  id: 1,
  name: 'TEST · RAMP',
  subtitle: 'Kicker, gap, landing deck',
  description: 'Build speed, launch off the 18° kicker, stabilize and stick the landing in the target.',
  theme: 'morning',
  spawn: { position: [0, 0.36, -8], yawDeg: 0, speed: 8 },
  killY: -40,
  vacuumEnabled: false,
  fuel: { capacity: 3.5, regenPerSec: 0.5, regenDelay: 1.2, start: 1 },
  pieces: [
    { kind: 'ribbon', id: 'ramp-runway', frames: rampRunway.frames, width: 20, style: 'runway', adhesive: false, edgeLights: 'white' },
    { kind: 'ribbon', id: 'ramp-kicker', frames: rampKicker.frames, width: 16, style: 'ramp', adhesive: false, edgeLights: 'orange' },
    { kind: 'ribbon', id: 'ramp-landing', frames: rampLanding.frames, width: 28, style: 'landing', adhesive: false, edgeLights: 'cyan' },
  ],
  zones: RAMP_ZONES,
  targetZoneId: 'ramp-target',
  objectives: [
    {
      id: 'ramp-speed',
      title: 'BUILD SPEED',
      text: 'Reach 120 km/h on the runway',
      hints: [{ keys: ['W'], label: 'Accelerate', actions: ['accelerate'] }],
      complete: (ctx) => rampH.speedKmh(ctx) >= 120,
    },
    {
      id: 'ramp-jump',
      title: 'CLEAR THE GAP',
      text: 'Launch off the kicker',
      hints: [
        { keys: ['A', 'D'], label: 'Align', actions: ['left', 'right'] },
        { keys: ['SPACE'], label: 'Thrusters', actions: ['boost'] },
      ],
      complete: (ctx) => rampH.happened(ctx, 'takeoff'),
    },
    {
      id: 'ramp-land',
      title: 'STICK THE LANDING',
      text: 'Land in the target zone',
      hints: [
        { keys: ['W', 'S'], label: 'Pitch', actions: ['accelerate', 'brake'] },
        { keys: ['SHIFT'], label: 'Stabilize', actions: ['stabilize'] },
      ],
      complete: (ctx) => rampH.landedIn(ctx, 'ramp-target', 'hard'),
      prompt: {
        text: 'HOLD SHIFT — STABILIZE',
        hint: { keys: ['SHIFT'], label: 'Stabilize', actions: ['stabilize'] },
        tone: 'action',
        when: (ctx) => rampH.airborneFor(ctx, 0, 1.2) && !ctx.input.stabilize,
        slowMo: 0.6,
      },
    },
  ],
  floatingHints: [
    { id: 'ramp-hint-speed', position: [12, 3, -120], text: 'FULL SPEED', hint: { keys: ['W'], label: 'Accelerate' }, objectiveId: 'ramp-speed' },
  ],
  finish: { zoneId: 'ramp-finish', minQuality: 'clean', settleTime: 1 },
  medals: { bronze: 1500, silver: 3500, gold: 6000 },
  intro: { from: [40, 18, 30], lookAt: [0, 0, -80], duration: 3 },
};

/** Frames exposed for autopilots / tools (centerline of the drivable path). */
export const TEST_RAMP_PATH: { runway: TrackFrame[]; kicker: TrackFrame[]; landing: TrackFrame[] } = {
  runway: rampRunway.frames,
  kicker: rampKicker.frames,
  landing: rampLanding.frames,
};

/* ================================================================== */
/* TEST_VACUUM                                                         */
/* ================================================================== */

const VAC_RUNWAY = 180;
/**
 * Crescent radii. The brief suggested R ≈ 26 / 22, but on such tight concave curves the 4.46 m chassis
 * (2.2 m overhangs, 14 cm clearance) grazes the surface with its nose and tail under the 2–4 g of
 * centripetal + suction load (≈ 2.3 s of belly contact per climb at 26 m/s ⇒ sparks / scrape events
 * all the way up). From R 32 / 28 the underbody stays clear at 22–26 m/s (see tests/physics/vacuum.test.ts).
 * Handcrafted crescents should keep at least these radii (≥ 40 / 34 also clears 32 m/s).
 */
const VAC_PIPE_RADIUS = 32;
const VAC_OVERHANG_RADIUS = 28;
const vacRunway = new TrackPath({ position: [0, 0, 0] }).straight(VAC_RUNWAY);
const vacClimb = TrackPath.fromFrame(vacRunway.end()).up(90, VAC_PIPE_RADIUS).straight(8).up(90, VAC_OVERHANG_RADIUS);
/** Arc length along the crescent where the inverted beam starts. */
const VAC_INVERTED_START = vacClimb.length;
const vacCrescent = vacClimb.straight(22).right(22, 70).straight(32);
const VAC_INVERTED_LENGTH = vacCrescent.length - VAC_INVERTED_START;
const vacBeamEnd = vacCrescent.end();
/** Release zone: last 20 m of the inverted beam. */
const vacReleaseFrame = vacCrescent.at(vacCrescent.length - 10);

/**
 * Ski-jump landing hill below/after the beam end: the car falls ≈ 12–20 m onto a 32° slope, so the
 * impact along the surface normal stays CLEAN even after a long inverted drop.
 */
const beamFwdFlat = new Vector3(vacBeamEnd.forward.x, 0, vacBeamEnd.forward.z).normalize();
const hillStart = vacBeamEnd.position.clone().addScaledVector(beamFwdFlat, 14).add(new Vector3(0, -15, 0));
const vacHill = new TrackPath({ position: hillStart, yawDeg: yawOf(beamFwdFlat), pitchDeg: -8 })
  .straight(6)
  .down(24, 45)
  .straight(48)
  .up(32, 75)
  .straight(150);
const vacHillEnd = vacHill.end();
const hillMid = vacHill.at(vacHill.length * 0.45);

const VAC_ZONES: ZoneDef[] = [
  {
    id: 'vac-release',
    purpose: 'trigger',
    center: pointV3(vacReleaseFrame.position.clone().addScaledVector(vacReleaseFrame.up, 1.5)),
    halfSize: [9, 4, 10],
    rotationDeg: [0, yawOf(new Vector3(vacReleaseFrame.forward.x, 0, vacReleaseFrame.forward.z)), 0],
    label: 'RELEASE',
    visible: true,
  },
  {
    id: 'vac-finish',
    purpose: 'finish',
    center: pointV3(hillMid.position.clone().add(new Vector3(0, 4, 0))),
    halfSize: [26, 40, 110],
    rotationDeg: [0, yawOf(beamFwdFlat), 0],
    visible: false,
  },
];
const vacH = createObjectiveHelpers(VAC_ZONES);

export const TEST_VACUUM: LevelDef = {
  id: 3,
  name: 'TEST · VACUUM',
  subtitle: 'Crescent ramp & inverted beam',
  description: 'Hold ENTER on the quarter pipe, climb the wall, drive the inverted beam, release and land on the hill.',
  theme: 'night',
  spawn: { position: [0, 0.36, -6], yawDeg: 0, speed: 10 },
  killY: -40,
  vacuumEnabled: true,
  fuel: { capacity: 4.5, regenPerSec: 0.5, regenDelay: 1, start: 1 },
  pieces: [
    { kind: 'ribbon', id: 'vac-runway', frames: vacRunway.frames, width: 20, style: 'runway', adhesive: true, edgeLights: 'white' },
    { kind: 'ribbon', id: 'vac-crescent', frames: vacCrescent.frames, width: 16, style: 'adhesive', adhesive: true, edgeLights: 'red' },
    { kind: 'ribbon', id: 'vac-hill', frames: vacHill.frames, width: 34, style: 'landing', adhesive: false, edgeLights: 'cyan' },
  ],
  zones: VAC_ZONES,
  objectives: [
    {
      id: 'vac-engage',
      title: 'ENGAGE VACUUM',
      text: 'Hold ENTER before the quarter pipe',
      hints: [{ keys: ['ENTER'], label: 'Vacuum', actions: ['vacuum'] }],
      complete: (ctx) => ctx.snapshot.vehicle.vacuum.mode === 'engaged' && ctx.snapshot.vehicle.up.y < 0.5,
    },
    {
      id: 'vac-inverted',
      title: 'DRIVE INVERTED',
      text: 'Drive the beam upside down to the release zone',
      hints: [
        { keys: ['ENTER'], label: 'Hold vacuum', actions: ['vacuum'] },
        { keys: ['W'], label: 'Accelerate', actions: ['accelerate'] },
      ],
      complete: (ctx) => ctx.inZone('vac-release'),
    },
    {
      id: 'vac-land',
      title: 'RELEASE & LAND',
      text: 'Release ENTER, roll upright and land on the hill',
      hints: [
        { keys: ['Q', 'E'], label: 'Roll', actions: ['rollLeft', 'rollRight'] },
        { keys: ['SHIFT'], label: 'Stabilize', actions: ['stabilize'] },
      ],
      complete: (ctx) => vacH.landedIn(ctx, 'vac-finish', 'hard'),
      prompt: {
        text: 'RELEASE ENTER',
        hint: { keys: ['ENTER'], label: 'Release', actions: ['vacuum'] },
        tone: 'action',
        when: (ctx) => ctx.inZone('vac-release') && ctx.input.vacuum,
      },
    },
  ],
  floatingHints: [
    {
      id: 'vac-hint-hold',
      position: [10, 4, -150],
      text: 'HOLD ENTER',
      hint: { keys: ['ENTER'], label: 'Vacuum' },
      objectiveId: 'vac-engage',
    },
  ],
  finish: { zoneId: 'vac-finish', minQuality: 'hard', settleTime: 1 },
  medals: { bronze: 2000, silver: 4500, gold: 8000 },
};

/** Frames exposed for autopilots / tools. */
export const TEST_VACUUM_PATH: {
  runway: TrackFrame[];
  crescent: TrackFrame[];
  hill: TrackFrame[];
  /** Arc length (on `crescent`) where the inverted beam starts / its length. */
  invertedStart: number;
  invertedLength: number;
} = {
  runway: vacRunway.frames,
  crescent: vacCrescent.frames,
  hill: vacHill.frames,
  invertedStart: VAC_INVERTED_START,
  invertedLength: VAC_INVERTED_LENGTH,
};

/** Hill end (for camera / debug framing). */
export const TEST_VACUUM_HILL_END: V3 = pointV3(vacHillEnd.position);

export const TEST_LEVELS = { flat: TEST_FLAT, ramp: TEST_RAMP, vacuum: TEST_VACUUM } as const;
export type TestLevelKey = keyof typeof TEST_LEVELS;
