/**
 * Small, composable predicates for `ObjectiveDef.complete` / `prompt.when` (level authoring).
 *
 * ```ts
 * const H = createObjectiveHelpers(zones);
 * complete: (ctx) => H.landedIn(ctx, 'target', 'clean'),
 * complete: (ctx) => H.happened(ctx, 'takeoff'),
 * when: (ctx) => H.airborneFor(ctx, 0, 1.2) && !ctx.input.stabilize,
 * ```
 */
import { ZoneTester } from '../track/zones';
import type { GameEventType, LandingQuality, ObjectiveContext, ZoneDef } from '../types';
import { landingRank } from './LandingEvaluator';

export interface ObjectiveHelpers {
  /** An event of `type` was emitted this tick. */
  happened(ctx: ObjectiveContext, type: GameEventType): boolean;
  /** A landing of at least `minQuality` happened this tick, touching down inside zone `zoneId`. */
  landedIn(ctx: ObjectiveContext, zoneId: string, minQuality?: Exclude<LandingQuality, 'crash'>): boolean;
  /** A landing of at least `minQuality` happened this tick (anywhere). */
  landed(ctx: ObjectiveContext, minQuality?: Exclude<LandingQuality, 'crash'>): boolean;
  /** Current speed in km/h. */
  speedKmh(ctx: ObjectiveContext): number;
  /** In a scored jump with air time within [min, max] seconds. */
  airborneFor(ctx: ObjectiveContext, min: number, max?: number): boolean;
  /** A trick of `kind` (optionally with at least `count` rotations) was completed this tick. */
  trick(ctx: ObjectiveContext, kind: string, count?: number): boolean;
}

export function createObjectiveHelpers(zones: readonly ZoneDef[]): ObjectiveHelpers {
  const testers = new Map<string, ZoneTester>();
  for (const z of zones) testers.set(z.id, new ZoneTester(z));
  const landed = (ctx: ObjectiveContext, minQuality: Exclude<LandingQuality, 'crash'> = 'hard', zoneId?: string) => {
    for (const e of ctx.events) {
      if (e.type !== 'landing' || landingRank(e.result.quality) < landingRank(minQuality)) continue;
      if (!zoneId) return true;
      const t = testers.get(zoneId);
      if (t?.contains(e.result.position, 0.5)) return true;
    }
    return false;
  };
  return {
    happened: (ctx, type) => ctx.events.some((e) => e.type === type),
    landedIn: (ctx, zoneId, minQuality = 'hard') => landed(ctx, minQuality, zoneId),
    landed: (ctx, minQuality = 'hard') => landed(ctx, minQuality),
    speedKmh: (ctx) => ctx.snapshot.vehicle.speed * 3.6,
    airborneFor: (ctx, min, max = Infinity) =>
      ctx.snapshot.air.airborne && ctx.snapshot.air.airTime >= min && ctx.snapshot.air.airTime <= max,
    trick: (ctx, kind, count = 1) => ctx.events.some((e) => e.type === 'trick' && e.trick.kind === kind && e.trick.count >= count),
  };
}
