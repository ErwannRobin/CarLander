/**
 * LEVEL 1 reference pilots — the canonical lesson run (and parametrized variants for the sweeps in
 * tests/levels/level1.test.ts):
 *
 *   run-up   full throttle down the runway, centered on the kicker (followTrack, W held)
 *   flight   at lift-off: let go of W, burn SPACE for 0.55 s (from 0.15 s after lift-off), tap W/S to
 *            put the nose on the landing slope, then hold SHIFT until touchdown → CLEAN, bullseye
 *   roll-out keep the car centered on the landing deck
 *
 * Only snapshot-based conditions are used, so the same pilot works through `asFunction()` (the
 * `?autopilot=1` demo path, which provides no events).
 */
import { Autopilot, cond, flipNTimes, followTrack, type AutopilotPhase, type Controller } from '../../sim/autopilot';
import type { InputState, TrackFrame } from '../../types';

export interface L1PilotOptions {
  /** Run-up target speed (m/s). Above top speed (default 90) = W held all the way. */
  speed?: number;
  /** Lateral offset from the centerline during the run-up (m, + = right). */
  offset?: number;
  /** Burn start after lift-off (s; negative = start on the kicker, before the lip) and duration (s). 0 duration = no thrust. */
  burnDelay?: number;
  burnDuration?: number;
  /** Keep W held this long after lift-off (a player who forgets to let go). */
  holdW?: number;
  /** Pitch the nose onto the predicted landing slope with W/S after the burn (closed loop). */
  matchSlope?: boolean;
  /** Stabilizer: from `stabilizeDelay` after lift-off ('after'), during the whole flight ('always') or never. */
  stabilize?: 'after' | 'always' | 'none';
  /** Seconds after lift-off when the stabilizer is pressed in 'after' mode (default: end of burn + pitch). */
  stabilizeDelay?: number;
  /** Roll-out speed on the deck (m/s). */
  rollOutSpeed?: number;
  /** A flip after the burn (trick runs); the stabilizer then takes over until touchdown. */
  flip?: 'back' | 'front' | 'none';
}

export interface L1PilotTrack {
  runway: TrackFrame[];
  kicker: TrackFrame[];
  deck: TrackFrame[];
}

export const L1_REFERENCE: Required<Omit<L1PilotOptions, 'stabilizeDelay'>> & { stabilizeDelay?: number } = {
  flip: 'none',
  speed: 90,
  offset: 0,
  burnDelay: 0.15,
  burnDuration: 0.55,
  holdW: 0,
  matchSlope: true,
  stabilize: 'after',
  rollOutSpeed: 20,
};

/**
 * W/S like a player: nose down (W) while it is more than `deadDeg` above the predicted landing
 * slope, nose up (S) when below; at most `maxTime` seconds of input (then the stabilizer takes over).
 */
function matchSlopeController(start: number, maxTime: number, deadDeg = 5): Controller {
  return (snap, ctx) => {
    const t = ctx.phaseTime;
    if (t < start || t > start + maxTime) return {};
    const p = snap.prediction;
    if (!p || !p.valid) return {};
    if (p.pitchErrorDeg > deadDeg) return { throttle: 1 };
    if (p.pitchErrorDeg < -deadDeg) return { throttle: -1 };
    return {};
  };
}

export function createL1Pilot(track: L1PilotTrack, options: L1PilotOptions = {}): Autopilot {
  const o = { ...L1_REFERENCE, ...options };
  const runUp = [track.runway, track.kicker];
  const burnEnd = o.burnDelay + o.burnDuration;
  const pitchStart = Math.max(0, burnEnd) + 0.02;
  const pitchTime = 0.45;
  const stabilizeAt = o.stabilizeDelay ?? (o.matchSlope ? pitchStart + pitchTime : Math.max(0, burnEnd));

  // burn before the lip (negative delay): starts on the kicker, `-burnDelay` seconds before lift-off,
  // estimated from the remaining distance to the lip at the current speed
  const lipZ = track.kicker[track.kicker.length - 1].position.z;
  const kickerBurn: Controller = (snap) => {
    if (o.burnDuration <= 0 || o.burnDelay >= 0) return {};
    const v = snap.vehicle;
    const toLip = v.position.z - lipZ;
    const tLip = toLip / Math.max(1, v.speed);
    return tLip <= -o.burnDelay ? { boost: true } : {};
  };

  // trick runs: one full flip right after the burn, then the stabilizer
  const flipping = o.flip !== 'none' ? flipNTimes(1, o.flip === 'back' ? 'back' : 'front', 60) : null;
  let flipDone = false;
  let flipRun = -1;
  const flight: Controller = (snap, ctx) => {
    const t = ctx.phaseTime;
    const out: Partial<InputState> = {};
    if (o.burnDuration > 0 && t >= o.burnDelay && t < burnEnd) out.boost = true;
    if (t < o.holdW) out.throttle = 1;
    if (flipping) {
      if (ctx.runId !== flipRun) {
        flipRun = ctx.runId;
        flipDone = false;
      }
      if (!flipDone && t >= Math.max(0, burnEnd) + 0.05) {
        const f = flipping(snap, ctx);
        if (f.throttle === undefined) flipDone = true;
        else return { ...out, ...f };
      }
      if (snap.vehicle.airborne && flipDone) out.stabilize = true;
      return out;
    }
    if (snap.vehicle.airborne) {
      if (o.stabilize === 'always' || (o.stabilize === 'after' && t >= stabilizeAt)) out.stabilize = true;
    }
    return out;
  };

  const phases: AutopilotPhase[] = [
    {
      name: 'run-up',
      controllers: [followTrack(runUp, o.speed, { offset: o.offset }), kickerBurn],
      until: (snap) => snap.vehicle.airborne,
      timeout: 40,
    },
    {
      name: 'flight',
      controllers: o.matchSlope && o.flip === 'none' ? [matchSlopeController(pitchStart, pitchTime), flight] : [flight],
      until: cond.touchedDown(2),
      timeout: 12,
    },
    { name: 'roll-out', controllers: [followTrack(track.deck, o.rollOutSpeed)] },
  ];
  return new Autopilot(phases);
}
