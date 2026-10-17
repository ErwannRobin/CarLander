/**
 * LEVEL 1 — tutorial flow: objectives (one mechanic each), center prompts and world-space hints.
 *
 *   1 FULL THROTTLE      W                 runway
 *   2 LINE UP            A / D             funnel → kicker ("let go at the lip" prompt on the kicker)
 *   3 FIRE THRUSTERS     SPACE             bullet-time prompt right after the lip (first attempt)
 *   4 MATCH THE SLOPE    W / S             pitch the nose onto the landing slope
 *   5 STABILIZE & LAND   SHIFT             hold the stabilizer, touch down inside the rings (finish)
 *
 * Every predicate first calls `track(ctx)`, which folds the tick into a per-run state (keyed by the
 * run's `ctx.memory` object, so it resets with the run). Prompts that change meaning after a missed
 * landing (retry advice) read that state through getters: ObjectiveRunner reads `prompt.text` /
 * `hint` / `tone` only when the prompt (re)appears, and the in-air and on-deck conditions never
 * overlap, so the PromptState always matches the situation.
 *
 * Never blocking: MATCH THE SLOPE also completes with the stabilizer held, or at touchdown, so a
 * landing in the target always finishes the level once the thrusters were fired.
 */
import { createObjectiveHelpers } from '../../sim/objectiveHelpers';
import { TUNING } from '../../tuning';
import type { ControlHint, FloatingHintDef, ObjectiveContext, ObjectiveDef, PromptState, V3, ZoneDef } from '../../types';

export const L1_ZONE = { kicker: 'l1-kicker', target: 'l1-target' } as const;
export const L1_OBJECTIVE = {
  throttle: 'l1-throttle',
  lineUp: 'l1-line-up',
  thrust: 'l1-thrust',
  slope: 'l1-slope',
  land: 'l1-land',
} as const;

/** Thresholds of the flow (exported for tests). */
export const L1_FLOW = {
  /** FULL THROTTLE completes at this speed (or once the car reaches the funnel, whatever the speed). */
  throttleKmh: 180,
  /** Lift-off speed under which a short landing is blamed on the run-up (m/s). */
  slowLipSpeed: 50,
  /** Seconds of W in the air (first 0.8 s of flight) that pitch the nose into the deck. */
  wInAir: 0.12,
  air: {
    /** Seconds of thrust (from the kicker on, mostly in the air) that complete FIRE THRUSTERS. */
    thrustBurn: 0.25,
    /** The thrust prompt shows during the first seconds of flight while SPACE is not held. */
    thrustPromptWindow: 1.3,
    /** Pitch error (deg) under which the attitude matches the landing slope … */
    alignedDeg: 8,
    /** … held this long (s); the MATCH THE SLOPE prompt shows above `promptDeg`. */
    alignedTime: 0.12,
    promptDeg: 11,
    /** Seconds of stabilizer that also complete MATCH THE SLOPE (it matches the slope for you). */
    stabilizeTime: 0.25,
  },
  /** First-attempt bullet time (sim time scale) per prompt. */
  slowMo: { thrust: 0.2, slope: 0.5, stabilize: 0.6 },
  /** Delay after a missed landing before the retry advice appears (s). */
  retryDelay: 0.6,
} as const;

/* ------------------------------------------------------------------ */
/* Per-run tracking                                                    */
/* ------------------------------------------------------------------ */

type LandingOutcome = 'none' | 'target' | 'short' | 'long';

export interface L1RunState {
  tick: number;
  /** Seconds since the car became airborne (current flight), 0 on the ground. */
  flightTime: number;
  /** Seconds of thrust while airborne during the current flight. */
  airBoost: number;
  /** Seconds of thrust since the car entered the kicker (kicker + air). */
  kickerBoost: number;
  onKicker: boolean;
  reachedKicker: boolean;
  /** Seconds aligned with the predicted landing surface (current flight). */
  alignedTime: number;
  /** Seconds of stabilizer while airborne (current flight). */
  stabTime: number;
  /** Wheels back on a surface after a flight (cleared on the next takeoff). */
  touchdown: boolean;
  /** Outcome of the last landing (cleared on the next takeoff) and its sim time. */
  landing: LandingOutcome;
  landingTime: number;
  /** The last landing came after a flight without any thrust. */
  landedWithoutThrust: boolean;
  /** Speed at lift-off (current / last flight, m/s). */
  lipSpeed: number;
  /** Seconds of W held during the first 0.8 s of the current flight. */
  airThrottle: number;
  /** Seconds of thrust on the ground since the run started (before the lip). */
  groundBoost: number;
  /** W (throttle) held this tick, and whether that changed this tick. */
  throttleHeld: boolean;
  throttleFlip: boolean;
}

const states = new WeakMap<object, L1RunState>();
/** State of the run whose predicates ran last (read by the prompt getters, see header). */
let live: L1RunState | null = null;

function freshState(): L1RunState {
  return {
    tick: -1,
    flightTime: 0,
    airBoost: 0,
    kickerBoost: 0,
    onKicker: false,
    reachedKicker: false,
    alignedTime: 0,
    stabTime: 0,
    touchdown: false,
    landing: 'none',
    landingTime: 0,
    landedWithoutThrust: false,
    lipSpeed: 0,
    airThrottle: 0,
    groundBoost: 0,
    throttleHeld: false,
    throttleFlip: false,
  };
}

export interface L1FlowGeometry {
  zones: ZoneDef[];
  /** World z of the target start / end (levels progress toward −Z). */
  targetStartZ: number;
  targetEndZ: number;
  /** World z where FULL THROTTLE completes regardless of speed (funnel entry). */
  funnelZ: number;
}

/** Retry advice after a landing outside the rings: names the actual mistake. */
export function l1RetryAdvice(s: L1RunState): string {
  const F = L1_FLOW;
  if (s.landing === 'long') return s.groundBoost >= 0.15 ? 'PRESS R — THRUSTERS ONLY AFTER THE LIP' : 'PRESS R — TRY A SHORTER BURN';
  if (s.landedWithoutThrust) return 'PRESS R — FIRE THRUSTERS AFTER THE LIP';
  if (s.airThrottle >= F.wInAir) return 'PRESS R — LET GO OF THE THROTTLE AT THE LIP';
  if (s.lipSpeed < F.slowLipSpeed) return 'PRESS R — FULL THROTTLE DOWN THE RUNWAY';
  return 'PRESS R — BURN A LITTLE LONGER';
}

const isMiss = (s: L1RunState | null): boolean => !!s && (s.landing === 'short' || s.landing === 'long');

export function createL1Flow(geo: L1FlowGeometry) {
  const H = createObjectiveHelpers(geo.zones);
  const F = L1_FLOW;

  /** Folds the current tick into the run state (idempotent within a tick). */
  function track(ctx: ObjectiveContext): L1RunState {
    let s = states.get(ctx.memory);
    if (!s) {
      s = freshState();
      states.set(ctx.memory, s);
    }
    live = s;
    const snap = ctx.snapshot;
    if (s.tick === snap.tick) return s;
    const dt = s.tick < 0 ? TUNING.dt : Math.max(0, snap.tick - s.tick) * TUNING.dt;
    s.tick = snap.tick;
    const v = snap.vehicle;
    const boosting = v.boosting;
    const held = ctx.input.throttle > 0.5;
    s.throttleFlip = held !== s.throttleHeld;
    s.throttleHeld = held;

    s.onKicker = ctx.inZone(L1_ZONE.kicker);
    if (s.onKicker) s.reachedKicker = true;
    if (s.reachedKicker && boosting) s.kickerBoost += dt;

    if (v.airborne) {
      if (s.flightTime === 0) {
        // takeoff: a new flight clears the previous landing
        s.airBoost = 0;
        s.alignedTime = 0;
        s.stabTime = 0;
        s.airThrottle = 0;
        s.touchdown = false;
        s.landing = 'none';
        s.lipSpeed = v.speed;
      }
      s.flightTime += dt;
      if (boosting) s.airBoost += dt;
      if (s.flightTime < 0.8 && ctx.input.throttle > 0.5) s.airThrottle += dt;
      if (ctx.input.stabilize) s.stabTime += dt;
      const p = snap.prediction;
      if (p && p.valid && Math.abs(p.pitchErrorDeg) <= F.air.alignedDeg && Math.abs(p.rollErrorDeg) <= 10) s.alignedTime += dt;
    } else {
      if (s.flightTime > 0 && v.groundedWheels > 0) {
        s.touchdown = true;
        s.flightTime = 0;
      }
      if (boosting && !s.touchdown) s.groundBoost += dt;
    }

    for (const e of ctx.events) {
      if (e.type !== 'landing') continue;
      const r = e.result;
      s.landingTime = snap.time;
      s.landedWithoutThrust = s.airBoost < 0.1 && s.kickerBoost < 0.1;
      if (r.quality === 'crash') s.landing = 'none';
      else if (r.inTarget) s.landing = 'target';
      else s.landing = r.position.z > geo.targetStartZ ? 'short' : 'long';
    }
    return s;
  }

  const missed = (s: L1RunState, snap: ObjectiveContext['snapshot']) =>
    (s.landing === 'short' || s.landing === 'long') && !snap.vehicle.airborne && snap.time - s.landingTime >= F.retryDelay;

  /* ---------------- hints ---------------- */
  const KEY_W: ControlHint = { keys: ['W'], label: 'Accelerate', actions: ['accelerate'] };
  const KEY_STEER: ControlHint = { keys: ['A', 'D'], label: 'Steer', actions: ['left', 'right'] };
  const KEY_SPACE: ControlHint = { keys: ['SPACE'], label: 'Thrusters', actions: ['boost'] };
  const KEY_PITCH: ControlHint = { keys: ['W', 'S'], label: 'Pitch', actions: ['accelerate', 'brake'] };
  const KEY_SHIFT: ControlHint = { keys: ['SHIFT'], label: 'Stabilize', actions: ['stabilize'] };
  const KEY_R: ControlHint = { keys: ['R'], label: 'Restart', actions: ['restart'] };

  const objectives: ObjectiveDef[] = [
    {
      id: L1_OBJECTIVE.throttle,
      title: 'FULL THROTTLE',
      text: 'Accelerate all the way down the runway.',
      hints: [KEY_W],
      complete: (ctx) => {
        track(ctx);
        return H.speedKmh(ctx) >= F.throttleKmh || ctx.snapshot.vehicle.position.z < geo.funnelZ;
      },
    },
    {
      id: L1_OBJECTIVE.lineUp,
      title: 'LINE UP',
      text: 'Steer onto the ramp, then let go at the lip.',
      hints: [KEY_STEER, KEY_W],
      complete: (ctx) => track(ctx).flightTime > 0,
      prompt: {
        // on the kicker, still on the throttle: prepare the release (W in the air = nose down)
        text: 'LET GO AT THE LIP',
        hint: { keys: ['W'], label: 'Release', actions: ['accelerate'] },
        tone: 'action',
        when: (ctx) => {
          const s = track(ctx);
          return s.onKicker && s.throttleHeld && !ctx.snapshot.vehicle.airborne;
        },
      },
    },
    {
      id: L1_OBJECTIVE.thrust,
      title: 'FIRE THRUSTERS',
      text: 'Hold the thrusters right after the lip.',
      hints: [KEY_SPACE],
      complete: (ctx) => {
        const s = track(ctx);
        return ctx.snapshot.vehicle.airborne && (s.airBoost >= F.air.thrustBurn || s.kickerBoost >= F.air.thrustBurn + 0.1);
      },
      prompt: {
        // in the air: the thrust lesson; on the deck after a miss: retry advice (see header)
        get text() {
          if (isMiss(live)) return l1RetryAdvice(live!);
          return live?.throttleHeld ? 'LET GO OF THE THROTTLE · HOLD SPACE' : 'HOLD SPACE — FIRE THRUSTERS';
        },
        get hint() {
          return isMiss(live) ? KEY_R : KEY_SPACE;
        },
        get tone(): PromptState['tone'] {
          return isMiss(live) ? 'warning' : 'action';
        },
        get slowMo() {
          return isMiss(live) ? undefined : F.slowMo.thrust;
        },
        when: (ctx) => {
          const s = track(ctx);
          const v = ctx.snapshot.vehicle;
          // until SPACE is held — and the throttle released (W in the air pitches the nose down).
          // A one-tick gap when the throttle state flips makes the runner rebuild the prompt text.
          if (v.airborne) return !s.throttleFlip && (!ctx.input.boost || s.throttleHeld) && s.flightTime > 0 && s.flightTime < F.air.thrustPromptWindow;
          return missed(s, ctx.snapshot);
        },
      },
    },
    {
      id: L1_OBJECTIVE.slope,
      title: 'MATCH THE SLOPE',
      text: 'Pitch the nose to line up with the deck.',
      hints: [KEY_PITCH],
      complete: (ctx) => {
        const s = track(ctx);
        return s.alignedTime >= F.air.alignedTime || s.stabTime >= F.air.stabilizeTime || s.touchdown;
      },
      prompt: {
        text: 'W / S — MATCH THE SLOPE',
        hint: KEY_PITCH,
        tone: 'action',
        slowMo: F.slowMo.slope,
        when: (ctx) => {
          track(ctx);
          const snap = ctx.snapshot;
          const p = snap.prediction;
          return snap.vehicle.airborne && !ctx.input.stabilize && !!p && p.valid && Math.abs(p.pitchErrorDeg) > F.air.promptDeg;
        },
      },
    },
    {
      id: L1_OBJECTIVE.land,
      title: 'STABILIZE & LAND',
      text: 'Hold the stabilizer and touch down inside the rings.',
      hints: [KEY_SHIFT, KEY_PITCH],
      complete: (ctx) => {
        track(ctx);
        return H.landedIn(ctx, L1_ZONE.target, 'hard');
      },
      prompt: {
        get text() {
          return isMiss(live) ? l1RetryAdvice(live!) : 'HOLD SHIFT — STABILIZE';
        },
        get hint() {
          return isMiss(live) ? KEY_R : KEY_SHIFT;
        },
        get tone(): PromptState['tone'] {
          return isMiss(live) ? 'warning' : 'action';
        },
        get slowMo() {
          return isMiss(live) ? undefined : F.slowMo.stabilize;
        },
        when: (ctx) => {
          const s = track(ctx);
          const snap = ctx.snapshot;
          if (snap.vehicle.airborne) return !ctx.input.stabilize && !!snap.prediction?.valid;
          return missed(s, snap);
        },
      },
    },
  ];

  return { objectives, track };
}

/** Floating hint placements (world), bound to objectives. */
export function createL1Hints(at: {
  throttle: V3;
  lineUp: V3;
  lip: V3;
  target: V3;
}): FloatingHintDef[] {
  return [
    {
      id: 'l1-hint-throttle',
      position: at.throttle,
      text: 'FULL THROTTLE',
      hint: { keys: ['W'], label: 'Hold', actions: ['accelerate'] },
      objectiveId: L1_OBJECTIVE.throttle,
    },
    {
      id: 'l1-hint-line-up',
      position: at.lineUp,
      text: 'LINE UP WITH THE RAMP',
      hint: { keys: ['A', 'D'], label: 'Steer', actions: ['left', 'right'] },
      objectiveId: L1_OBJECTIVE.lineUp,
    },
    {
      id: 'l1-hint-lip',
      position: at.lip,
      text: 'LET GO AT THE LIP',
      hint: { keys: ['W'], label: 'Release', actions: ['accelerate'] },
      objectiveId: L1_OBJECTIVE.lineUp,
    },
    {
      id: 'l1-hint-target',
      position: at.target,
      text: 'LAND IN THE RINGS',
      hint: { keys: ['SHIFT'], label: 'Stabilize', actions: ['stabilize'] },
      objectiveId: L1_OBJECTIVE.land,
    },
  ];
}
