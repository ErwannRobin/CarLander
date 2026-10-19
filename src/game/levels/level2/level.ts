/**
 * LEVEL 2 — LevelDef builder: zones, objectives, prompts, floating hints, fuel, medals and intro
 * for a course (see ./course.ts). `LEVEL_2` in ../level2.ts is `buildLevel2(L2_COURSE)`.
 */
import { createObjectiveHelpers } from '../../sim/objectiveHelpers';
import type { ControlHint, FloatingHintDef, LevelDef, ObjectiveContext, ObjectiveDef, ZoneDef } from '../../types';
import { L2_COURSE, type L2Course } from './course';

const DEG = 180 / Math.PI;

/** Bonus for threading the suspended ring gate (added once per run). */
export const L2_RING_BONUS = 1500;

/** Builds the LevelDef for a course (default geometry: L2_COURSE). */
export function buildLevel2(C: L2Course = L2_COURSE): LevelDef {

  /* ------------------------------------------------------------------ */
  /* Zones                                                               */
  /* ------------------------------------------------------------------ */

  const target = C.target;
  const targetPitch = Math.asin(Math.max(-1, Math.min(1, target.forward.y))) * DEG;
  const tc = target.position.clone().addScaledVector(target.up, 1.5);
  const finishTop = C.yKnuckle + 18;
  const finishBottom = C.yFinish - 6;

  const ZONES: ZoneDef[] = [
    {
      id: 'l2-finish',
      purpose: 'finish',
      center: [0, (finishTop + finishBottom) / 2, (C.zKnuckle + 4 + C.zEnd) / 2],
      halfSize: [C.layout.params.landWidthBottom / 2 + 6, (finishTop - finishBottom) / 2, (C.zKnuckle + 4 - C.zEnd) / 2],
      visible: false,
    },
    {
      id: 'l2-target',
      purpose: 'target',
      center: [tc.x, tc.y, tc.z],
      halfSize: [C.targetHalf[0], 3.5, C.targetHalf[1]],
      rotationDeg: [targetPitch, 0, 0],
      label: 'TARGET',
    },
    {
      id: 'l2-gate',
      purpose: 'gate',
      center: C.gate,
      halfSize: [C.gateRadius, C.gateRadius, 3],
      label: 'RING GATE',
    },
    {
      // threading region (inner square of the ring): emits 'checkpoint' (chime) and pays the bonus
      id: 'l2-ring',
      purpose: 'checkpoint',
      center: C.gate,
      halfSize: [C.gateRadius * 0.68, C.gateRadius * 0.68, 3],
      visible: false,
    },
  ];

  const H = createObjectiveHelpers(ZONES);

  /* ------------------------------------------------------------------ */
  /* Predicates                                                          */
  /* ------------------------------------------------------------------ */

  const zOf = (ctx: ObjectiveContext) => ctx.snapshot.vehicle.position.z;
  /** Between the K1 lip and the boost straight (the trick kickers section). */
  const onKickers = (ctx: ObjectiveContext) => zOf(ctx) < C.zK1Lip + 3 && zOf(ctx) > C.zBoostStart;
  /** Off the second kicker (its lip to the boost straight). */
  const onK2 = (ctx: ObjectiveContext) => zOf(ctx) < C.zK2Lip + 3 && zOf(ctx) > C.zBoostStart;
  /** Rolling on the boost straight: the kicker section is over. */
  const pastKickers = (ctx: ObjectiveContext) => zOf(ctx) < C.zBoostStart - 25 && !ctx.snapshot.air.airborne;
  /** A rotation is well under way (≥ 250° on any axis) or a rotation trick registered. */
  const rotationCommitted = (ctx: ObjectiveContext) => {
    const r = ctx.snapshot.air.rotation;
    if (Math.max(Math.abs(r.pitch), Math.abs(r.yaw), Math.abs(r.roll)) >= 250) return true;
    return ctx.events.some((e) => e.type === 'trick' && (e.trick.kind === 'backflip' || e.trick.kind === 'frontflip' || e.trick.kind === 'spin' || e.trick.kind === 'barrelRoll'));
  };
  /** Airborne off the big launch ramp. */
  const leftBigLip = (ctx: ObjectiveContext) => ctx.snapshot.air.airborne && zOf(ctx) < C.zBigRampStart;
  /** On the big launch ramp (or just before it). */
  const onBigRamp = (ctx: ObjectiveContext) => zOf(ctx) < C.zBigRampStart + 35 && zOf(ctx) > C.zLip;
  /** Landing-hill surface height at z (the course is straight along −Z); null before the knuckle. */
  const hill = C.layout.landing;
  const hillY = (z: number): number | null => {
    if (z > hill[0].position.z) return null;
    for (let i = 1; i < hill.length; i++) {
      const a = hill[i - 1].position;
      const b = hill[i].position;
      if (z >= b.z) return a.y + ((b.y - a.y) * (z - a.z)) / (b.z - a.z || 1);
    }
    return hill[hill.length - 1].position.y;
  };
  /** The predicted touchdown is short of the landing hill (the catch shelf under it, or nothing at all). */
  const predictedShort = (ctx: ObjectiveContext) => {
    const p = ctx.snapshot.prediction;
    if (!p || !p.valid) return true;
    const y = hillY(p.point.z);
    return y === null || p.point.y < y - 3;
  };

  /** Pays the ring-gate bonus once per run (evaluated by whichever objective is active). */
  function withRingBonus(complete: (ctx: ObjectiveContext) => boolean): (ctx: ObjectiveContext) => boolean {
    return (ctx) => {
      if (!ctx.memory.ring && ctx.events.some((e) => e.type === 'checkpoint' && e.id === 'l2-ring')) {
        ctx.memory.ring = true;
        // The sim has no zone-bonus hook yet: bank the bonus straight into the run score.
        ctx.snapshot.score.total += L2_RING_BONUS;
      }
      return complete(ctx);
    };
  }

  /* ------------------------------------------------------------------ */
  /* Control hints                                                       */
  /* ------------------------------------------------------------------ */

  const K_BACKFLIP: ControlHint = { keys: ['S'], label: 'Backflip', actions: ['brake'] };
  const K_FRONTFLIP: ControlHint = { keys: ['W'], label: 'Frontflip', actions: ['accelerate'] };
  const K_REALIGN: ControlHint = { keys: ['SHIFT'], label: 'Realign', actions: ['stabilize'] };
  const K_THRUST: ControlHint = { keys: ['SPACE'], label: 'Thrust', actions: ['boost'] };
  const K_BOOST: ControlHint = { keys: ['SPACE'], label: 'Boost', actions: ['boost'] };
  const K_ACCEL: ControlHint = { keys: ['W'], label: 'Accelerate', actions: ['accelerate'] };
  const K_PITCH: ControlHint = { keys: ['W', 'S'], label: 'Pitch', actions: ['accelerate', 'brake'] };

  /* ------------------------------------------------------------------ */
  /* Objectives                                                          */
  /* ------------------------------------------------------------------ */

  const OBJECTIVES: ObjectiveDef[] = [
    {
      id: 'l2-flip',
      title: 'TRICK KICKERS',
      text: 'Hold S in the air to backflip',
      hints: [K_BACKFLIP, K_FRONTFLIP],
      // optional: done once a rotation is under way, or skipped when the kickers are behind
      complete: withRingBonus((ctx) => (onKickers(ctx) && rotationCommitted(ctx)) || pastKickers(ctx)),
      prompt: {
        text: 'HOLD S — BACKFLIP',
        hint: K_BACKFLIP,
        tone: 'action',
        when: (ctx) =>
          onKickers(ctx) &&
          ctx.snapshot.air.airborne &&
          ctx.snapshot.air.airTime < 0.9 &&
          Math.abs(ctx.snapshot.air.rotation.pitch) < 60 &&
          ctx.input.throttle > -0.5,
        slowMo: 0.5,
      },
    },
    {
      id: 'l2-stick',
      title: 'LAND IT',
      text: 'Release, then hold SHIFT to land on four wheels',
      hints: [K_REALIGN],
      complete: withRingBonus((ctx) => H.landed(ctx, 'hard') || pastKickers(ctx)),
      prompt: {
        text: 'HOLD SHIFT — REALIGN',
        hint: K_REALIGN,
        tone: 'action',
        when: (ctx) => onKickers(ctx) && ctx.snapshot.air.airborne && !ctx.input.stabilize,
        slowMo: 0.6,
      },
    },
    {
      id: 'l2-flip2',
      title: 'SECOND KICKER',
      text: 'Hold W in the air to frontflip',
      hints: [K_FRONTFLIP, K_REALIGN],
      // optional: done when a rotation off K2 is landed, or skipped when the kickers are behind
      complete: withRingBonus((ctx) => {
        if (onK2(ctx) && rotationCommitted(ctx)) ctx.memory.flip2 = true;
        return (!!ctx.memory.flip2 && H.landed(ctx, 'hard')) || pastKickers(ctx);
      }),
      prompt: {
        text: 'HOLD W — FRONTFLIP',
        hint: K_FRONTFLIP,
        tone: 'action',
        when: (ctx) =>
          onK2(ctx) &&
          ctx.snapshot.air.airborne &&
          ctx.snapshot.air.airTime < 0.9 &&
          Math.abs(ctx.snapshot.air.rotation.pitch) < 60 &&
          ctx.input.throttle < 0.5,
      },
    },
    {
      id: 'l2-boost',
      title: 'BOOST',
      text: 'Full speed, then hold SPACE up the big ramp',
      hints: [K_ACCEL, K_BOOST],
      complete: withRingBonus(leftBigLip),
      prompt: {
        text: 'HOLD SPACE — BOOST',
        hint: K_BOOST,
        tone: 'action',
        when: (ctx) => onBigRamp(ctx) && !ctx.snapshot.air.airborne && !ctx.input.boost && ctx.snapshot.vehicle.fuel > 0.3,
        slowMo: 0.6,
      },
    },
    {
      id: 'l2-thrust',
      title: 'CLEAR THE GAP',
      text: 'Fly through the ring. Thrust if you fall short',
      hints: [K_THRUST, K_PITCH],
      complete: withRingBonus((ctx) => zOf(ctx) < C.gate[2] - 4 || H.landed(ctx, 'hard')),
      prompt: {
        text: 'HOLD SPACE — THRUST',
        hint: K_THRUST,
        tone: 'action',
        when: (ctx) =>
          ctx.snapshot.air.airborne &&
          !ctx.input.boost &&
          ctx.snapshot.vehicle.fuel > 0.08 &&
          zOf(ctx) > C.gate[2] + 12 &&
          predictedShort(ctx),
        slowMo: 0.5,
      },
    },
    {
      id: 'l2-land',
      title: 'STICK THE LANDING',
      text: 'Realign with the slope, land on all four wheels',
      hints: [K_REALIGN, K_PITCH],
      complete: withRingBonus((ctx) => H.landedIn(ctx, 'l2-finish', 'hard')),
      prompt: {
        text: 'HOLD SHIFT — REALIGN',
        hint: K_REALIGN,
        tone: 'action',
        when: (ctx) => {
          const p = ctx.snapshot.prediction;
          return ctx.snapshot.air.airborne && !ctx.input.stabilize && !!p && p.valid && p.timeToImpact < 2.4;
        },
        slowMo: 0.7,
      },
    },
  ];

  /* ------------------------------------------------------------------ */
  /* Floating hints                                                      */
  /* ------------------------------------------------------------------ */

  /** Drive-surface height of the backbone at z (signs float 5.5 m above the deck beside the track). */
  const deckY = (z: number) => {
    let best = C.layout.backbone[0];
    for (const f of C.layout.backbone) if (Math.abs(f.position.z - z) < Math.abs(best.position.z - z)) best = f;
    return best.position.y;
  };
  const sign = (x: number, z: number): [number, number, number] => [x, deckY(z) + 5.5, z];
  const FLOATING_HINTS: FloatingHintDef[] = [
    { id: 'l2-hint-flip', position: sign(15, C.zK1Start + 70), text: 'HOLD S IN THE AIR', hint: K_BACKFLIP, objectiveId: 'l2-flip' },
    { id: 'l2-hint-flip2', position: sign(-15, C.zK2Start + 60), text: 'HOLD W IN THE AIR', hint: K_FRONTFLIP, objectiveId: 'l2-flip2' },
    { id: 'l2-hint-speed', position: sign(-15, C.zBoostStart - 70), text: 'FULL SPEED', hint: K_ACCEL, objectiveId: 'l2-boost' },
    { id: 'l2-hint-boost', position: sign(15, C.zBigRampStart + 40), text: 'BOOST UP THE RAMP', hint: K_BOOST, objectiveId: 'l2-boost' },
  ];

  /* ------------------------------------------------------------------ */
  /* Level                                                               */
  /* ------------------------------------------------------------------ */

  return {
    id: 4,
    name: 'CLEAR THE GAP',
    subtitle: 'Golden-hour canyon',
    description: 'Two trick kickers, a boost up the big ramp, then a 190-metre chasm. Thread the ring, realign and land on all four wheels.',
    theme: 'canyon',
    spawn: { position: [0, C.yStart + 0.36, C.zSpawn], yawDeg: 0, speed: 16 },
    killY: C.killY,
    vacuumEnabled: false,
    fuel: { capacity: 0.5, regenPerSec: 0.25, regenDelay: 1, start: 1 },
    pieces: C.layout.pieces,
    zones: ZONES,
    objectives: OBJECTIVES,
    floatingHints: FLOATING_HINTS,
    targetZoneId: 'l2-target',
    finish: { zoneId: 'l2-finish', minQuality: 'hard', settleTime: 1 },
    medals: { bronze: 5000, silver: 11000, gold: 19000 },
    intro: { from: [78, C.yStart + 70, 120], lookAt: [0, C.yLip - 10, C.zLip - 120], duration: 3.4 },
  };
}
