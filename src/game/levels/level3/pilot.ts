/**
 * LEVEL 3 — reference autopilot (headless tests, `?autopilot=1` demo runs). Snapshot-only
 * conditions, so it also works through `asFunction()` (no events).
 *
 * Default run = what a confident player does: W held on every surface, ENTER from 60 m before the
 * quarter pipe, release in the middle of the RELEASE zone, SHIFT to flip upright, roll out.
 * The road is one straight line (no jump), so there is a single climb phase from the spawn.
 */
import {
  Autopilot,
  cond,
  followTrack,
  rollToUpright,
  stabilizeInAir,
  TrackTracker,
  type AutopilotPhase,
  type Controller,
} from '../../sim/autopilot';
import type { SimSnapshot } from '../../types';
import type { L3Geometry } from './geometry';

export type SpeedSetting = number | 'hold';

export interface L3PilotOptions {
  /** Speed on the runway and the arena road (m/s), or 'hold' = W held the whole time. Default 'hold'. */
  runSpeed?: SpeedSetting;
  /** Speed on the crescent climb. Default 'hold'. */
  climbSpeed?: SpeedSetting;
  /** Speed on the inverted beam. Default 'hold'. */
  beamSpeed?: SpeedSetting;
  /** Start holding ENTER this many meters before the crescent entry (negative = already on the pipe). Default 60. */
  vacuumLead?: number;
  /** Release ENTER this many meters before the beam end. Default: the middle of the RELEASE zone. */
  releaseBefore?: number;
  /** Reorientation after the release: SHIFT, Q/E roll (like a player), flight assist only, or nothing. Default 'stabilize'. */
  recovery?: 'stabilize' | 'roll' | 'assist' | 'none';
  /** Reaction time before the recovery input starts (s after the release). Default 0. */
  recoveryDelay?: number;
  /** Hold SHIFT from this many meters before the release point (pre-armed stabilizer, the taught technique). Default 25; 0 = only after the release. */
  stabilizeLead?: number;
  /** Optional thrust burn in the release flight: delay after the release and duration (s). */
  thrust?: { start: number; duration: number };
}

const HOLD_SPEED = 75; // a target above the top speed ⇒ followTrack outputs full throttle

const speedOf = (s: SpeedSetting) => (s === 'hold' ? HOLD_SPEED : s);

/** Thrust between `start` and `start + duration` seconds of the current phase. */
function burn(start: number, duration: number): Controller {
  return (_s, ctx) => ({ boost: ctx.phaseTime >= start && ctx.phaseTime < start + duration });
}

/** Runs `inner` only after `delay` seconds of the current phase. */
function after(delay: number, inner: Controller): Controller {
  return (snap, ctx) => (ctx.phaseTime >= delay ? inner(snap, ctx) : {});
}

export function createL3Pilot(geo: L3Geometry, opts: L3PilotOptions = {}): Autopilot {
  const runSpeed = speedOf(opts.runSpeed ?? 'hold');
  const climbSpeed = speedOf(opts.climbSpeed ?? 'hold');
  const beamSpeed = speedOf(opts.beamSpeed ?? 'hold');
  const vacuumLead = opts.vacuumLead ?? 60;
  const releaseBefore = opts.releaseBefore ?? geo.params.releaseMargin + geo.params.releaseLength / 2;
  const recoveryMode = opts.recovery ?? 'stabilize';
  const stabilizeLead = recoveryMode === 'stabilize' && !opts.recoveryDelay ? (opts.stabilizeLead ?? 25) : 0;

  // one continuous road: runway → arena lane → crescent
  const mainFrames = [geo.runway, geo.deck, geo.crescent];
  const runLen = geo.runway[geo.runway.length - 1].s;
  const deckEnd = runLen + geo.deck[geo.deck.length - 1].s;
  const main = new TrackTracker(mainFrames);
  const progress = (snap: SimSnapshot) => main.update(snap.vehicle.position).s;
  const vacuumFrom = deckEnd - vacuumLead;
  const beamFrom = deckEnd + geo.invertedStart;
  const releaseAt = deckEnd + geo.crescentLength - releaseBefore;

  const approachSpeed = (s: number) => (s >= beamFrom ? beamSpeed : s >= deckEnd ? climbSpeed : runSpeed);
  const phases: AutopilotPhase[] = [
    {
      name: 'climb',
      controllers: [
        followTrack(mainFrames, approachSpeed),
        (snap) => {
          const p = progress(snap);
          return { vacuum: p >= vacuumFrom, stabilize: stabilizeLead > 0 && p >= releaseAt - stabilizeLead };
        },
      ],
      // release at the chosen point — or once the car has left the beam (ENTER held past the end)
      until: (snap) => progress(snap) >= releaseAt || (progress(snap) > beamFrom && snap.vehicle.airborne),
      timeout: 40,
    },
  ];
  const delay = opts.recoveryDelay ?? 0;
  const recovery: Controller[] = [];
  if (recoveryMode === 'roll') recovery.push(after(delay, rollToUpright()));
  else if (recoveryMode === 'stabilize') recovery.push(after(delay, stabilizeLead > 0 ? () => ({ stabilize: true }) : stabilizeInAir()));
  if (opts.thrust) recovery.push(burn(opts.thrust.start, opts.thrust.duration));
  phases.push(
    { name: 'release', controllers: recovery, until: cond.touchedDown(3), timeout: 8 },
    { name: 'roll-out', controllers: [followTrack(geo.hill, 18)] },
  );
  return new Autopilot(phases);
}
