/**
 * LEVEL 3 — THE INVERTED RAMP: LevelDef factory (pieces, zones, objectives, prompts, hints).
 */
import { Vector3 } from 'three';
import { createObjectiveHelpers } from '../../sim/objectiveHelpers';
import { frameAt } from '../../track/TrackPath';
import type { LevelDef, ObjectiveContext, PieceDef, ZoneDef } from '../../types';
import { L3_GEO, v3, yawOf, type L3Geometry } from './geometry';

export const L3_IDS = {
  runway: 'l3-runway',
  kicker: 'l3-kicker',
  deck: 'l3-deck',
  crescent: 'l3-crescent',
  hill: 'l3-hill',
  arena: 'l3-arena',
  start: 'l3-start',
  deckZone: 'l3-deck-zone',
  pipe: 'l3-pipe',
  release: 'l3-release',
  target: 'l3-target',
  finish: 'l3-finish',
} as const;

export function createLevel3(geo: L3Geometry = L3_GEO): LevelDef {
  const p = geo.params;
  const deckLen = geo.deck[geo.deck.length - 1].s;
  const rampEnd = geo.rampLength * 0.7;

  // deck: wide landing ramp narrowing to the crescent width along the approach lane
  const deckWidth = (s: number) => {
    if (s <= rampEnd) return p.deckWidth;
    const t = Math.min(1, (s - rampEnd) / Math.max(1, deckLen - rampEnd - 8));
    const e = t * t * (3 - 2 * t);
    return p.deckWidth + (p.crescentWidth - p.deckWidth) * e;
  };

  const pieces: PieceDef[] = [
    { kind: 'ribbon', id: L3_IDS.runway, frames: geo.runway, width: p.runwayWidth, style: 'runway', adhesive: false, edgeLights: 'red' },
    { kind: 'ribbon', id: L3_IDS.kicker, frames: geo.kicker, width: p.runwayWidth, style: 'adhesive', adhesive: false, edgeLights: 'red' },
    { kind: 'ribbon', id: L3_IDS.deck, frames: geo.deck, width: deckWidth, style: 'runway', adhesive: true, edgeLights: 'red' },
    { kind: 'ribbon', id: L3_IDS.crescent, frames: geo.crescent, width: p.crescentWidth, style: 'adhesive', adhesive: true, edgeLights: 'red' },
    { kind: 'ribbon', id: L3_IDS.hill, frames: geo.hill, width: p.hillWidth, style: 'landing', adhesive: false, edgeLights: 'cyan' },
    // dark arena floor around the crescent base and the start apron (wide 'runway' boxes render the
    // marking-free asphalt apron); the ribbons run 5 cm above them
    { kind: 'box', id: L3_IDS.arena, center: geo.arena.center, size: geo.arena.size, style: 'runway', edgeLights: 'red' },
    { kind: 'box', id: L3_IDS.start, center: geo.start.center, size: geo.start.size, style: 'runway', edgeLights: 'red' },
  ];

  // ---- zones ----
  const deckMid = frameAt(geo.deck, deckLen * 0.5);
  const deckTopY = geo.deck[0].position.y;
  const deckLowY = geo.deck[geo.deck.length - 1].position.y;
  // last 70 m of the approach lane before the quarter pipe (vacuum prompt)
  const pipeFrame = frameAt(geo.deck, deckLen - 35);
  const releaseMid = frameAt(geo.crescent, (geo.releaseStart + geo.releaseEnd) / 2);
  const releaseYaw = yawOf(new Vector3(releaseMid.forward.x, 0, releaseMid.forward.z).normalize());
  const finishLen = geo.outrunStart + 50;
  const hillMid = frameAt(geo.hill, finishLen * 0.5);
  const hillYaw = yawOf(geo.releaseHeading);
  const targetFrame = frameAt(geo.hill, geo.outrunStart * 0.42);
  const targetPitch = Math.asin(Math.max(-1, Math.min(1, targetFrame.forward.y))) / (Math.PI / 180);

  const zones: ZoneDef[] = [
    {
      id: L3_IDS.deckZone,
      purpose: 'trigger',
      center: [deckMid.position.x, (deckTopY + deckLowY) / 2 + 4, deckMid.position.z],
      halfSize: [p.deckWidth / 2 + 6, (deckTopY - deckLowY) / 2 + 10, deckLen / 2 + 4],
      visible: false,
    },
    {
      id: L3_IDS.pipe,
      purpose: 'trigger',
      center: v3(pipeFrame.position.clone().add(new Vector3(0, 4, 0))),
      halfSize: [p.deckWidth / 2 + 4, 8, 35],
      visible: false,
    },
    {
      id: L3_IDS.release,
      purpose: 'trigger',
      // the car hangs under the beam: the zone box straddles the drive surface (frame up = world down)
      center: v3(releaseMid.position.clone().addScaledVector(releaseMid.up, 1.2)),
      halfSize: [p.crescentWidth / 2 + 1, 4, p.releaseLength / 2],
      rotationDeg: [0, releaseYaw, 0],
      label: 'RELEASE',
      visible: true,
    },
    {
      id: L3_IDS.target,
      purpose: 'target',
      center: v3(targetFrame.position.clone().addScaledVector(targetFrame.up, 1.5)),
      halfSize: [p.hillWidth / 2 - 2, 4, 26],
      rotationDeg: [targetPitch, hillYaw, 0],
      label: 'TARGET',
    },
    {
      id: L3_IDS.finish,
      purpose: 'finish',
      center: v3(hillMid.position),
      halfSize: [p.hillWidth / 2 + 8, 70, finishLen / 2 + 6],
      rotationDeg: [0, hillYaw, 0],
      label: 'FINISH',
    },
  ];
  const H = createObjectiveHelpers(zones);
  const onCrescent = (ctx: ObjectiveContext) => ctx.snapshot.vehicle.vacuum.mode === 'engaged' && ctx.snapshot.vehicle.up.y < 0.5;

  const level: LevelDef = {
    id: 3,
    name: 'THE INVERTED RAMP',
    subtitle: 'Night arena',
    description:
      'Jump the void onto the night arena, hold the vacuum up an 86-metre crescent, drive the beam upside down, release, flip upright and land on the distant ski-jump hill.',
    theme: 'night',
    spawn: { position: [0, 0.36, p.spawnZ], yawDeg: 0, speed: p.spawnSpeed },
    killY: -50,
    vacuumEnabled: true,
    fuel: { capacity: 3.5, regenPerSec: 0.6, regenDelay: 0.8, start: 1 },
    pieces,
    zones,
    targetZoneId: L3_IDS.target,
    objectives: [
      {
        id: 'l3-jump',
        title: 'AERIAL APPROACH',
        text: 'Jump the void onto the arena deck',
        hints: [
          { keys: ['W'], label: 'Accelerate', actions: ['accelerate'] },
          { keys: ['SHIFT'], label: 'Stabilize', actions: ['stabilize'] },
        ],
        complete: (ctx) => H.landedIn(ctx, L3_IDS.deckZone, 'hard') || onCrescent(ctx),
      },
      {
        id: 'l3-vacuum',
        title: 'ENGAGE VACUUM',
        text: 'Hold ENTER before the quarter pipe',
        hints: [
          { keys: ['ENTER'], label: 'Vacuum', actions: ['vacuum'] },
          { keys: ['A', 'D'], label: 'Line up', actions: ['left', 'right'] },
        ],
        complete: onCrescent,
        prompt: {
          text: 'HOLD ENTER — VACUUM',
          hint: { keys: ['ENTER'], label: 'Vacuum', actions: ['vacuum'] },
          tone: 'action',
          when: (ctx) => ctx.inZone(L3_IDS.pipe) && !ctx.input.vacuum,
          slowMo: 0.5,
        },
      },
      {
        id: 'l3-inverted',
        title: 'DRIVE INVERTED',
        text: 'Keep holding ENTER along the beam',
        hints: [
          { keys: ['ENTER'], label: 'Hold vacuum', actions: ['vacuum'] },
          { keys: ['W'], label: 'Accelerate', actions: ['accelerate'] },
        ],
        complete: (ctx) => ctx.inZone(L3_IDS.release) || (ctx.snapshot.air.airborne && ctx.snapshot.vehicle.up.y < 0),
      },
      {
        id: 'l3-release',
        title: 'RELEASE',
        text: 'Hold SHIFT, then let go of ENTER in the zone',
        hints: [
          { keys: ['SHIFT'], label: 'Hold', actions: ['stabilize'] },
          { keys: ['ENTER'], label: 'Release', actions: ['vacuum'] },
        ],
        complete: (ctx) => ctx.snapshot.air.airborne,
        prompt: {
          text: 'RELEASE ENTER',
          hint: { keys: ['ENTER'], label: 'Release', actions: ['vacuum'] },
          tone: 'action',
          when: (ctx) => ctx.inZone(L3_IDS.release) && ctx.input.vacuum,
          slowMo: 0.5,
        },
      },
      {
        id: 'l3-land',
        title: 'STICK THE LANDING',
        text: 'Flip upright and land on the hill',
        hints: [
          { keys: ['SHIFT'], label: 'Stabilize', actions: ['stabilize'] },
          { keys: ['Q', 'E'], label: 'Roll', actions: ['rollLeft', 'rollRight'] },
          { keys: ['SPACE'], label: 'Thrust', actions: ['boost'] },
        ],
        complete: (ctx) => H.landedIn(ctx, L3_IDS.finish, 'hard'),
        prompt: {
          text: 'HOLD SHIFT — FLIP UPRIGHT',
          hint: { keys: ['SHIFT'], label: 'Stabilize', actions: ['stabilize'] },
          tone: 'action',
          when: (ctx) =>
            ctx.snapshot.air.airborne &&
            ctx.snapshot.vehicle.up.y < 0.2 &&
            !ctx.input.stabilize &&
            Math.abs(ctx.input.roll) < 0.5,
          slowMo: 0.5,
        },
      },
    ],
    floatingHints: [
      {
        id: 'l3-hint-throttle',
        position: [p.runwayWidth / 2 + 5, 4.5, p.spawnZ - 70],
        text: 'FULL THROTTLE',
        hint: { keys: ['W'], label: 'Accelerate', actions: ['accelerate'] },
        objectiveId: 'l3-jump',
      },
      {
        id: 'l3-hint-vacuum',
        position: v3(frameAt(geo.deck, deckLen - 30).position.clone().add(new Vector3(p.crescentWidth / 2 + 9, 5.5, 0))),
        text: 'HOLD ENTER',
        hint: { keys: ['ENTER'], label: 'Vacuum', actions: ['vacuum'] },
        objectiveId: 'l3-vacuum',
      },
    ],
    finish: { zoneId: L3_IDS.finish, minQuality: 'hard', settleTime: 1 },
    medals: { bronze: 3500, silver: 7500, gold: 11000 },
    intro: { from: [-150, 34, -70], lookAt: [15, 38, -215], duration: 3.8 },
  };
  return level;
}
