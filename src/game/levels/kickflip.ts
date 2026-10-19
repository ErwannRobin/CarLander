/**
 * LEVEL 2 — KICKFLIP (theme 'night', after Tesla's "The Kickflip" stunt).
 *
 * Floor it down a flat runway toward five cars parked broadside on the lot, hop over them with the
 * jump jets (hold F), do a kickflip (a full barrel roll with Q / E) in the air, then stabilize
 * (SHIFT) and land on the hill. Landing without the kickflip does not finish the level.
 * Geometry: ./kickflip/layout.ts · reference pilot: ./kickflip/pilot.ts · proof: src/test/kickflip.test.ts.
 */
import type { Autopilot } from '../sim/autopilot';
import { createObjectiveHelpers } from '../sim/objectiveHelpers';
import type { ControlHint, LevelDef, ObjectiveContext, PieceDef, V3, ZoneDef } from '../types';
import { deckSlopeAt } from './level1/layout';
import { KF, KF_CARS, KF_GAP_MID_Z, KF_LOT_Y } from './kickflip/layout';
import { createKickflipPilot, type KickflipPilotOptions } from './kickflip/pilot';

export const KF_ZONE = { lot: 'kf-lot', target: 'kf-target', deck: 'kf-deck' } as const;
export const KF_OBJECTIVE = { throttle: 'kf-throttle', jump: 'kf-jump', kickflip: 'kf-kickflip', land: 'kf-land' } as const;

const targetCenter = KF.deck.at(KF.targetS.center);
const targetSlope = deckSlopeAt(KF, KF.targetS.center);
const deckMid = KF.deck.at(KF.deck.length / 2);
const finishFrame = KF.deck.end();
const gapLen = KF.lip.position.z - KF.deckStart.position.z;

const TARGET_CENTER: V3 = [0, targetCenter.position.y + targetCenter.up.y * 1.5, targetCenter.position.z];
const TARGET_HALF: V3 = [KF.params.targetHalfWidth, 8, (KF.targetS.end - KF.targetS.start) / 2];

const ZONES: ZoneDef[] = [
  {
    // the lot with the parked cars: "hold F" prompt shows on approach
    id: KF_ZONE.lot,
    purpose: 'trigger',
    center: [0, KF_LOT_Y + 3, KF_GAP_MID_Z + gapLen / 2],
    halfSize: [KF.params.deckWidth / 2 + 2, 8, gapLen / 2 + 14],
    visible: false,
  },
  {
    // whole landing deck + lot: "no kickflip" retry advice shows here
    id: KF_ZONE.deck,
    purpose: 'trigger',
    center: [0, deckMid.position.y, (KF.lip.position.z + finishFrame.position.z) / 2],
    halfSize: [KF.params.deckWidth / 2 + 4, 60, (KF.lip.position.z - finishFrame.position.z) / 2],
    visible: false,
  },
  {
    id: KF_ZONE.target,
    purpose: 'target',
    center: TARGET_CENTER,
    halfSize: TARGET_HALF,
    rotationDeg: [-targetSlope, 0, 0],
    label: 'TARGET',
  },
  {
    id: 'kf-finish-arch',
    purpose: 'finish',
    center: TARGET_CENTER,
    halfSize: TARGET_HALF,
    rotationDeg: [-targetSlope, 0, 0],
    label: 'FINISH',
  },
];

const H = createObjectiveHelpers(ZONES);
const KICKFLIP = 'kickflip';
const didKickflip = (ctx: ObjectiveContext) => {
  if (ctx.memory[KICKFLIP]) return true;
  if (H.trick(ctx, 'barrelRoll', 1)) ctx.memory[KICKFLIP] = true;
  return ctx.memory[KICKFLIP] === true;
};
const JUMP_HINT: ControlHint = { keys: ['F'], label: 'Jump', actions: ['jump'] };
const ROLL_HINT: ControlHint = { keys: ['Q', 'E'], label: 'Kickflip', actions: ['rollLeft', 'rollRight'] };

/** Parked cars: thin collision blocks inside each body (the car models are drawn by the decor). */
const block = (id: string, x: number, z: number, size: V3): PieceDef => ({
  kind: 'box',
  id,
  center: [x, KF_LOT_Y + size[1] / 2, z],
  size,
  style: 'metal',
  edgeLights: 'none',
});
// collision kept inside each body shell (the vehicle models are drawn by the decor)
const carBlocks: PieceDef[] = KF_CARS.flatMap((c, i) => {
  const [L, Hh, W] = c.size;
  const [x, , z] = c.position;
  const w = W - 0.3;
  if (c.kind === 'semi') {
    return [
      block(`kf-car-${i}-chassis`, x, z, [L * 0.95, Hh * 0.32, w]),
      block(`kf-car-${i}-cab`, x + L * 0.2, z, [L * 0.45, Hh * 0.9, w]),
    ];
  }
  return [block(`kf-car-${i}`, x, z, [L * 0.88, Hh * 0.55, w])];
});

export const LEVEL_KICKFLIP: LevelDef = {
  id: 2,
  name: 'KICKFLIP',
  subtitle: 'Night show',
  description: 'Floor it at five parked vehicles (a semi truck in the middle), hop over them with the jump jets (F), kickflip the roadster mid-air with Q / E, then stabilize and stick the landing.',
  theme: 'night',
  spawn: { position: [0, 0.36, -20], yawDeg: 0, speed: 18 },
  killY: Math.round(finishFrame.position.y - 30),
  vacuumEnabled: false,
  // one good hop: enough fuel to clear the semi, not enough to fly on forever
  fuel: { capacity: 0.9, regenPerSec: 0, regenDelay: 1.2, start: 1 },
  pieces: [
    { kind: 'box', id: 'kf-start-plaza', center: [0, -1.6, 20], size: [56, 3.2, 40], style: 'platform' },
    {
      kind: 'ribbon',
      id: 'kf-runway',
      frames: KF.runway.frames,
      width: KF.runwayWidthAt,
      style: 'runway',
      adhesive: false,
      edgeLights: 'white',
      label: 'RUNWAY',
    },
    {
      // the parking lot with the cars, at runway level
      kind: 'box',
      id: 'kf-lot',
      center: [0, KF_LOT_Y - 1, KF_GAP_MID_Z],
      size: [KF.params.deckWidth, 2, gapLen + 2],
      style: 'runway',
      edgeLights: 'red',
    },
    ...carBlocks,
    { kind: 'ribbon', id: 'kf-apron', frames: KF.apronFrames, width: KF.params.deckWidth, thickness: 1.6, style: 'platform', adhesive: false, edgeLights: 'cyan', label: 'APRON' },
    { kind: 'ribbon', id: 'kf-hill', frames: KF.hillFrames, width: KF.params.deckWidth, thickness: 1.6, style: 'landing', adhesive: false, edgeLights: 'cyan', label: 'LANDING HILL' },
  ],
  zones: ZONES,
  targetZoneId: KF_ZONE.target,
  objectives: [
    {
      id: KF_OBJECTIVE.throttle,
      title: 'FULL THROTTLE',
      text: 'Floor it and line up with the cars',
      hints: [
        { keys: ['W'], label: 'Accelerate', actions: ['accelerate'] },
        { keys: ['A', 'D'], label: 'Line up', actions: ['left', 'right'] },
      ],
      complete: (ctx) => ctx.inZone(KF_ZONE.lot) || ctx.snapshot.vehicle.airborne,
    },
    {
      id: KF_OBJECTIVE.jump,
      title: 'JUMP',
      text: 'Hold F to hop over the cars',
      hints: [JUMP_HINT],
      complete: (ctx) => ctx.snapshot.vehicle.airborne,
      prompt: {
        text: 'HOLD F — JUMP!',
        hint: JUMP_HINT,
        tone: 'action',
        when: (ctx) => ctx.inZone(KF_ZONE.lot) && !ctx.snapshot.vehicle.airborne && !ctx.input.jump,
        slowMo: 0.5,
      },
    },
    {
      id: KF_OBJECTIVE.kickflip,
      title: 'KICKFLIP',
      text: 'Over the cars: hold Q or E for a full roll',
      hints: [ROLL_HINT],
      complete: didKickflip,
      prompt: {
        text: 'HOLD Q / E — KICKFLIP!',
        hint: ROLL_HINT,
        tone: 'action',
        when: (ctx) => ctx.snapshot.vehicle.airborne && !ctx.input.roll,
        slowMo: 0.35,
      },
    },
    {
      id: KF_OBJECTIVE.land,
      title: 'STICK THE LANDING',
      text: 'Hold SHIFT and land in the rings',
      hints: [{ keys: ['SHIFT'], label: 'Stabilize', actions: ['stabilize'] }],
      complete: (ctx) => H.landedIn(ctx, KF_ZONE.target, 'hard'),
      prompt: {
        text: 'HOLD SHIFT — STABILIZE',
        hint: { keys: ['SHIFT'], label: 'Stabilize', actions: ['stabilize'] },
        tone: 'action',
        when: (ctx) => ctx.snapshot.vehicle.airborne && !ctx.input.stabilize,
        slowMo: 0.6,
      },
    },
  ],
  floatingHints: [
    { id: 'kf-hint-throttle', position: [-14, 4.8, -90], text: 'FLOOR IT', hint: { keys: ['W'], label: 'Accelerate', actions: ['accelerate'] }, objectiveId: KF_OBJECTIVE.throttle },
    { id: 'kf-hint-jump', position: [-10, 4, KF_GAP_MID_Z + 20], text: 'JUMP', hint: JUMP_HINT, objectiveId: KF_OBJECTIVE.jump },
    { id: 'kf-hint-flip', position: [10, 8, KF_GAP_MID_Z], text: 'KICKFLIP', hint: ROLL_HINT, objectiveId: KF_OBJECTIVE.kickflip },
  ],
  finish: { zoneId: KF_ZONE.target, minQuality: 'hard', settleTime: 1 },
  touchAssist: { ignorePitch: true, autoStabilize: 1.3 },
  medals: { bronze: 3000, silver: 5600, gold: 8500 },
  intro: { from: [24, 22, KF_GAP_MID_Z + 40], lookAt: [0, 2, KF_GAP_MID_Z], duration: 8 },
};

export function kickflipPilotWith(options: KickflipPilotOptions = {}): Autopilot {
  return createKickflipPilot({ runway: KF.runway.frames, kicker: KF.kicker.frames, deck: KF.deck.frames }, options);
}

export function kickflipPilot(): Autopilot {
  return kickflipPilotWith();
}
