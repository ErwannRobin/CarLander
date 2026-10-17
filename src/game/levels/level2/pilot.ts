/**
 * LEVEL 2 — reference autopilot (headless completion tests, sweeps and `?autopilot=1` demo runs).
 *
 * Only snapshot-based conditions are used, so it also works through `asFunction()` (no events).
 * Default line (skilled): W all the way, BACKFLIP off K1, FRONTFLIP off K2, SPACE up the big ramp
 * (the 0.5 s tank empties before the lip), a BACKFLIP over the chasm through the ring, SHIFT, land.
 *
 * Air behaviour per jump, in phase time (seconds since leaving the lip):
 *   [0, preW)                  W still held from the run-up (a keyboard player's reaction delay)
 *   kickers: trick from `trickDelay`, released `releaseLeadDeg` before a full turn, then SHIFT
 *   big jump: nothing (or SHIFT) until `thrustDelay`, SPACE for `thrustTime`, then trick, then SHIFT
 */
import type { InputState, SimSnapshot } from '../../types';
import { Autopilot, followTrack, type AutopilotContext, type Controller } from '../../sim/autopilot';
import { L2_COURSE, type L2Course } from './course';

export type L2Trick = 'none' | 'backflip' | 'frontflip' | 'spin' | 'barrelRoll';

export interface L2PilotOptions {
  /** Run-up cruise speed (m/s): W held below it, released above. `Infinity` (default) = W held the whole time. */
  speed?: number;
  k1Trick?: L2Trick;
  k2Trick?: L2Trick;
  bigTrick?: L2Trick;
  /** Seconds W stays held after leaving a lip (reaction delay). Default 0. */
  preW?: number;
  /** Big jump: thrust start after leaving the lip (s) and how long SPACE is held (s). 0 = no thrust. */
  thrustDelay?: number;
  thrustTime?: number;
  /** Hold SHIFT after tricks / the burn (default true). With false only flight assist realigns. */
  stabilize?: boolean;
  /** Hold SHIFT before the big-jump burn starts (default false: the player reacts to the thrust prompt). */
  stabilizeBeforeThrust?: boolean;
  /** Hold SHIFT during the big-jump burn (default false). */
  stabilizeDuringThrust?: boolean;
  /** Seconds of ground thrust on the boost straight, starting `groundBoostAt` m before the big ramp. */
  groundBoost?: number;
  groundBoostAt?: number;
  /** Delay before starting a kicker trick after leaving the lip (s). */
  trickDelay?: number;
  /** Release a kicker rotation this many degrees before the full turn (SHIFT completes it). */
  releaseLeadDeg?: number;
  /**
   * Same for the big-jump trick. From the 27° lip onto the ≈ 30° hill an aligned backflip is only
   * ≈ 305°, so a backflip must be held past 360° (negative lead) before SHIFT rotates back.
   */
  bigReleaseLeadDeg?: number;
  /** Delay between the end of the burn and the big-jump trick (s). */
  bigTrickDelay?: number;
  /** Start at a later phase (tools / tests that place the car on the boost straight). */
  startPhase?: 'run-up' | 'straight';
}

const DEFAULTS: Required<L2PilotOptions> = {
  speed: Infinity,
  k1Trick: 'backflip',
  k2Trick: 'frontflip',
  bigTrick: 'backflip',
  preW: 0,
  thrustDelay: 0.25,
  thrustTime: 0,
  stabilize: true,
  stabilizeBeforeThrust: false,
  stabilizeDuringThrust: false,
  groundBoost: 0.6,
  groundBoostAt: 10,
  trickDelay: 0.05,
  releaseLeadDeg: 100,
  bigReleaseLeadDeg: -25,
  bigTrickDelay: 0.05,
  startPhase: 'run-up',
};

/** Tank capacity of the level (s): a held SPACE stops thrusting once it is empty. */
const TANK = 0.5;

const AXIS: Record<Exclude<L2Trick, 'none'>, { axis: 'pitch' | 'yaw' | 'roll'; input: 'throttle' | 'steer' | 'roll'; sign: number }> = {
  backflip: { axis: 'pitch', input: 'throttle', sign: -1 }, // S = nose up
  frontflip: { axis: 'pitch', input: 'throttle', sign: 1 }, // W = nose down
  spin: { axis: 'yaw', input: 'steer', sign: -1 }, // A = yaw left
  barrelRoll: { axis: 'roll', input: 'roll', sign: 1 }, // E = roll right
};

/**
 * Trick input (held until `360 − lead` degrees on its axis) from phase time `startAt`, then SHIFT.
 * Returns null while the trick has not started yet.
 */
function trickThenStabilize(
  snap: SimSnapshot,
  ctx: AutopilotContext,
  trick: L2Trick,
  startAt: number,
  lead: number,
  stabilize: boolean,
  key: string,
): Partial<InputState> | null {
  if (trick !== 'none' && !ctx.memory[key]) {
    if (ctx.phaseTime < startAt) return null;
    const a = AXIS[trick];
    if (Math.abs(snap.air.rotation[a.axis]) < 360 - lead) return { [a.input]: a.sign };
    ctx.memory[key] = true;
  }
  return stabilize ? { stabilize: true } : {};
}

/** Snapshot-only touchdown detector for a phase: was in a scored jump, now back on ≥ 3 wheels. */
function touchedDown(): (snap: SimSnapshot, ctx: AutopilotContext) => boolean {
  return (snap, ctx) => {
    const key = `air:${ctx.phaseIndex}`;
    if (snap.air.airborne) ctx.memory[key] = true;
    return !!ctx.memory[key] && !snap.air.airborne && snap.vehicle.groundedWheels >= 3;
  };
}

export function createLevel2Pilot(opts: L2PilotOptions = {}, C: L2Course = L2_COURSE): Autopilot {
  const o: Required<L2PilotOptions> = { ...DEFAULTS, ...opts };
  const L = C.layout;
  const follow = followTrack([L.backbone, L.landing], () => o.speed, { lookaheadTime: 0.3 });
  const run: Controller = (snap, ctx) => {
    const out = follow(snap, ctx);
    // W held (Infinity), or a player cruising at a target speed: W on below it, off above (never brakes)
    if (out.throttle !== undefined) out.throttle = o.speed === Infinity ? 1 : snap.vehicle.forwardSpeed < o.speed ? 1 : 0;
    return out;
  };
  const airborneBeyond = (z: number) => (snap: SimSnapshot) => snap.air.airborne && snap.vehicle.position.z < z;
  const groundBoost: Controller = (snap) => {
    if (o.groundBoost <= 0 || snap.vehicle.airborne) return {};
    const d = snap.vehicle.position.z - C.zBigRampStart; // distance before the ramp start (m)
    const span = o.groundBoost * Math.max(20, snap.vehicle.speed);
    return { boost: d < o.groundBoostAt && d > o.groundBoostAt - span };
  };
  const kickerAir =
    (trick: L2Trick, key: string): Controller =>
    (snap, ctx) => {
      if (!snap.vehicle.airborne) return {};
      if (ctx.phaseTime < o.preW) return { throttle: 1 };
      return trickThenStabilize(snap, ctx, trick, Math.max(o.trickDelay, o.preW), o.releaseLeadDeg, o.stabilize, key) ?? {};
    };
  const bigAir: Controller = (snap, ctx) => {
    if (!snap.vehicle.airborne) return {};
    const t = ctx.phaseTime;
    const out: Partial<InputState> = {};
    if (t < o.preW) out.throttle = 1;
    const burnEnd = o.thrustTime > 0 ? o.thrustDelay + Math.min(o.thrustTime, TANK) : 0;
    if (o.thrustTime > 0 && t < o.thrustDelay) {
      if (o.stabilizeBeforeThrust) out.stabilize = true;
      return out;
    }
    if (o.thrustTime > 0 && t < o.thrustDelay + o.thrustTime) {
      out.boost = true;
      if (o.stabilizeDuringThrust) out.stabilize = true;
      if (t < burnEnd) return out;
    }
    if (t < o.preW) return out;
    const after = trickThenStabilize(snap, ctx, o.bigTrick, burnEnd + o.bigTrickDelay, o.bigReleaseLeadDeg, o.stabilize, 'big');
    return { ...out, ...(after ?? {}) };
  };
  const kickers = [
    { name: 'run-up', controllers: [run], until: airborneBeyond(C.zK1Start), timeout: 30 },
    { name: 'k1-air', controllers: [kickerAir(o.k1Trick, 'k1')], until: touchedDown(), timeout: 8 },
    { name: 'to-k2', controllers: [run], until: airborneBeyond(C.zK2Start), timeout: 30 },
    { name: 'k2-air', controllers: [kickerAir(o.k2Trick, 'k2')], until: touchedDown(), timeout: 8 },
  ];
  return new Autopilot([
    ...(o.startPhase === 'run-up' ? kickers : []),
    { name: 'straight', controllers: [run, groundBoost], until: airborneBeyond(C.zBigRampStart), timeout: 30 },
    { name: 'big-air', controllers: [bigAir], until: touchedDown(), timeout: 12 },
    { name: 'roll-out', controllers: [followTrack(L.landing, 12)] },
  ]);
}
