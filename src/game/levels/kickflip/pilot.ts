/**
 * LEVEL 2 — KICKFLIP reference pilot: full throttle down the flat runway, hold the jump jets (F)
 * just before the cars to hop over them, one barrel roll (E) once airborne, then the stabilizer
 * until touchdown, roll out.
 */
import { Autopilot, cond, followTrack, rotateNTimes, type Controller } from '../../sim/autopilot';
import type { InputState, TrackFrame } from '../../types';

export interface KickflipPilotOptions {
  speed?: number;
  /** Distance before the first car (m) where the jump jets fire. */
  jumpBefore?: number;
  /** How long the jump jets are held (s). */
  jumpDuration?: number;
  /** Seconds after lift-off when the roll starts. */
  rollDelay?: number;
  /** false = no kickflip (must not finish). */
  kickflip?: boolean;
  /** false = never press jump (must crash into the cars). */
  jump?: boolean;
}

export function createKickflipPilot(
  track: { runway: TrackFrame[]; kicker: TrackFrame[]; deck: TrackFrame[] },
  options: KickflipPilotOptions = {},
): Autopilot {
  const o = { speed: 55, jumpBefore: 24, jumpDuration: 0.8, rollDelay: 0.85, kickflip: true, jump: true, ...options };
  const roll = rotateNTimes('roll', 1, 1, 40);
  let done = false;
  let run = -1;
  // the cars stand on the lot right after the runway end (the kicker is flat / zero-length)
  const runwayEndZ = track.runway[track.runway.length - 1].position.z;
  const flight: Controller = (snap, ctx) => {
    if (ctx.runId !== run) {
      run = ctx.runId;
      done = false;
    }
    const t = ctx.phaseTime;
    const out: Partial<InputState> = {};
    if (o.jump && t < o.jumpDuration) out.jump = true;
    if (o.kickflip && !done && snap.vehicle.airborne && t >= o.rollDelay) {
      const r = roll(snap, ctx);
      if (r.roll === undefined) done = true;
      else return { ...out, ...r };
    }
    if (snap.vehicle.airborne && (done || !o.kickflip)) out.stabilize = true;
    return out;
  };
  return new Autopilot([
    { name: 'run-up', controllers: [followTrack([track.runway, track.kicker], o.speed)], until: (s) => s.vehicle.position.z < runwayEndZ + o.jumpBefore, timeout: 40 },
    { name: 'flight', controllers: [flight], until: cond.touchedDown(2), timeout: 12 },
    { name: 'roll-out', controllers: [followTrack(track.deck, 20)] },
  ]);
}
