/**
 * Autopilot — scripted and closed-loop input generation for headless tests, level design tuning,
 * demo runs (`devHooks.autopilot`) and screenshot automation.
 *
 * An autopilot is an ordered list of phases. Each phase merges a static input with any number of
 * controllers (later ones override earlier ones field by field) until its `until` condition holds
 * (a predicate or a duration in seconds), then the next phase starts.
 *
 * ```ts
 * const pilot = new Autopilot([
 *   { name: 'run-up', controllers: [followTrack(frames, 40)], until: cond.airborne() },
 *   { name: 'flight', controllers: [stabilizeInAir()], until: cond.event('landing') },
 *   { name: 'roll-out', controllers: [followTrack(frames, 15)], until: 3 },
 * ]);
 * const report = runAutopilot(sim, pilot, { maxTime: 30, stopWhen: cond.complete() });
 * // or, live: devHooks.autopilot = pilot.asFunction();
 * ```
 *
 * Track-relative helpers work on any surface orientation (inverted beams included) because they
 * measure errors in the track frame's own axes.
 */
import { Vector3 } from 'three';
import type { GameEvent, GameEventType, InputState, SimSnapshot, TrackFrame } from '../types';
import { NEUTRAL_INPUT } from '../types';
import type { GameSim } from './GameSim';

/* ------------------------------------------------------------------ */
/* Core types                                                          */
/* ------------------------------------------------------------------ */

export interface AutopilotContext {
  /** Sim time (s). */
  readonly time: number;
  /** Seconds since the current phase started. */
  readonly phaseTime: number;
  readonly phaseIndex: number;
  readonly phaseName: string;
  /** Events produced by the sim since the previous tick (empty when driven by snapshot only). */
  readonly events: readonly GameEvent[];
  /** Scratch memory shared by all phases of one run (cleared by `reset()`). */
  readonly memory: Record<string, unknown>;
  /** Incremented whenever the autopilot restarts (reset, or the sim was reset underneath it). */
  readonly runId: number;
}

export type Controller = (snap: SimSnapshot, ctx: AutopilotContext) => Partial<InputState>;
export type Condition = (snap: SimSnapshot, ctx: AutopilotContext) => boolean;

export interface AutopilotPhase {
  name: string;
  /** Static input applied for the whole phase (merged before controllers). */
  input?: Partial<InputState>;
  /** Closed-loop controllers, merged in order (later wins per field). */
  controllers?: Controller[];
  /** Ends the phase: predicate, or a duration in seconds. Omitted = never ends (final phase). */
  until?: Condition | number;
  /** Safety timeout in seconds: the phase ends anyway (and `timedOut` is recorded). */
  timeout?: number;
}

interface MutableContext {
  time: number;
  phaseTime: number;
  phaseIndex: number;
  phaseName: string;
  events: readonly GameEvent[];
  memory: Record<string, unknown>;
  runId: number;
}

/* ------------------------------------------------------------------ */
/* Autopilot                                                           */
/* ------------------------------------------------------------------ */

export class Autopilot {
  readonly phases: AutopilotPhase[];
  /** Phase start log (name, sim time, timedOut) for reports. */
  readonly log: { name: string; start: number; timedOut: boolean }[] = [];
  private index = 0;
  private phaseStart = 0;
  private started = false;
  private readonly ctx: MutableContext = { time: 0, phaseTime: 0, phaseIndex: 0, phaseName: '', events: [], memory: {}, runId: 0 };
  private readonly out: InputState = { ...NEUTRAL_INPUT };

  constructor(phases: AutopilotPhase[]) {
    this.phases = phases;
  }

  reset(): void {
    this.index = 0;
    this.phaseStart = 0;
    this.started = false;
    this.log.length = 0;
    this.ctx.memory = {};
  }

  get done(): boolean {
    return this.index >= this.phases.length;
  }

  get phaseName(): string {
    return this.phases[this.index]?.name ?? 'done';
  }

  /**
   * Input for the next tick. Pass the events drained since the previous call for event-based
   * conditions (cond.event / cond.landed). Returns neutral input when all phases are done.
   */
  next(snap: SimSnapshot, events: readonly GameEvent[] = []): InputState {
    const ctx = this.ctx;
    ctx.time = snap.time;
    ctx.events = events;
    if (!this.started || snap.time < this.phaseStart) {
      // first call, or the sim was reset underneath us
      this.started = true;
      this.index = 0;
      this.log.length = 0;
      ctx.memory = {};
      ctx.runId++;
      this.enter(0, snap.time, false);
    }
    // advance through finished phases (several may end in the same tick)
    for (let guard = 0; guard < this.phases.length && this.index < this.phases.length; guard++) {
      const phase = this.phases[this.index];
      ctx.phaseTime = snap.time - this.phaseStart;
      ctx.phaseIndex = this.index;
      ctx.phaseName = phase.name;
      const u = phase.until;
      const ended = typeof u === 'number' ? ctx.phaseTime >= u : u ? u(snap, ctx) : false;
      const timedOut = !ended && phase.timeout !== undefined && ctx.phaseTime >= phase.timeout;
      if (!ended && !timedOut) break;
      this.enter(this.index + 1, snap.time, timedOut);
    }
    const out = Object.assign(this.out, NEUTRAL_INPUT);
    const phase = this.phases[this.index];
    if (!phase) return out;
    ctx.phaseTime = snap.time - this.phaseStart;
    if (phase.input) Object.assign(out, phase.input);
    if (phase.controllers) for (const c of phase.controllers) Object.assign(out, c(snap, ctx));
    return out;
  }

  /** Adapter for `devHooks.autopilot` / the runner: `(snapshot) => InputState` (no events). */
  asFunction(): (snapshot: SimSnapshot) => InputState {
    return (snapshot) => ({ ...this.next(snapshot) });
  }

  private enter(i: number, time: number, timedOutPrev: boolean): void {
    if (timedOutPrev && this.log.length > 0) this.log[this.log.length - 1].timedOut = true;
    this.index = i;
    this.phaseStart = time;
    const p = this.phases[i];
    if (p) this.log.push({ name: p.name, start: time, timedOut: false });
  }
}

/* ------------------------------------------------------------------ */
/* Running                                                             */
/* ------------------------------------------------------------------ */

export interface RunOptions {
  /** Hard limit in sim seconds. */
  maxTime: number;
  /** Stop when this holds (evaluated after each tick). */
  stopWhen?: Condition;
  /** Called after each tick. */
  onTick?: (sim: GameSim, input: InputState, events: readonly GameEvent[]) => void;
  /** Stop when the sim completes the level (default true). */
  stopOnComplete?: boolean;
  /** Stop on crash (default false: crashes keep simulating like the game does). */
  stopOnCrash?: boolean;
}

export interface RunReport {
  time: number;
  ticks: number;
  events: GameEvent[];
  phases: Autopilot['log'];
  stoppedBy: 'condition' | 'complete' | 'crash' | 'timeout' | 'done';
}

/** Drives `sim` with `pilot` until a stop condition; returns all events and the phase log. */
export function runAutopilot(sim: GameSim, pilot: Autopilot, opts: RunOptions): RunReport {
  const all: GameEvent[] = [...sim.drainEvents()];
  let recent: GameEvent[] = all.slice();
  let ticks = 0;
  const stopOnComplete = opts.stopOnComplete ?? true;
  let stoppedBy: RunReport['stoppedBy'] = 'timeout';
  const t0 = sim.snapshot.time;
  const stopCtx: MutableContext = { time: 0, phaseTime: 0, phaseIndex: -1, phaseName: '', events: [], memory: {}, runId: 0 };
  while (sim.snapshot.time - t0 < opts.maxTime) {
    const input = pilot.next(sim.snapshot, recent);
    sim.step(input);
    ticks++;
    recent = sim.drainEvents();
    for (const e of recent) all.push(e);
    opts.onTick?.(sim, input, recent);
    if (stopOnComplete && sim.snapshot.phase === 'complete') {
      stoppedBy = 'complete';
      break;
    }
    if (opts.stopOnCrash && sim.snapshot.phase === 'crashed') {
      stoppedBy = 'crash';
      break;
    }
    if (opts.stopWhen) {
      stopCtx.time = sim.snapshot.time;
      stopCtx.phaseName = pilot.phaseName;
      stopCtx.events = recent;
      if (opts.stopWhen(sim.snapshot, stopCtx)) {
        stoppedBy = 'condition';
        break;
      }
    }
    if (pilot.done) {
      stoppedBy = 'done';
      break;
    }
  }
  return { time: sim.snapshot.time - t0, ticks, events: all, phases: pilot.log, stoppedBy };
}

/* ------------------------------------------------------------------ */
/* Conditions                                                          */
/* ------------------------------------------------------------------ */

export const cond = {
  /** Phase has lasted `seconds`. */
  after: (seconds: number): Condition => (_s, c) => c.phaseTime >= seconds,
  /** Sim time reached `t`. */
  atTime: (t: number): Condition => (s) => s.time >= t,
  /** A scored jump is in progress. */
  airborne: (): Condition => (s) => s.air.airborne,
  /** At least `n` wheels on a surface. */
  grounded: (n = 2): Condition => (s) => s.vehicle.groundedWheels >= n,
  /** An event of `type` occurred this tick. */
  event: (type: GameEventType): Condition => (_s, c) => c.events.some((e) => e.type === type),
  landed: (): Condition => (_s, c) => c.events.some((e) => e.type === 'landing'),
  /**
   * Snapshot-only landing detector (works without events, e.g. through `asFunction()`): true once
   * the car has been in a scored jump during this phase and is now back on ≥ `wheels` wheels.
   */
  touchedDown: (wheels = 3): Condition => {
    let wasAir = false;
    let phase = -1;
    let run = -1;
    return (s, c) => {
      if (c.phaseIndex !== phase || c.runId !== run) {
        phase = c.phaseIndex;
        run = c.runId;
        wasAir = false;
      }
      if (s.air.airborne) wasAir = true;
      return wasAir && !s.air.airborne && s.vehicle.groundedWheels >= wheels;
    };
  },
  crashed: (): Condition => (s) => s.phase === 'crashed',
  complete: (): Condition => (s) => s.phase === 'complete',
  speedAbove: (ms: number): Condition => (s) => s.vehicle.speed >= ms,
  speedBelow: (ms: number): Condition => (s) => s.vehicle.speed <= ms,
  /** Car origin passed a plane: `axis` coordinate below/above `value` (e.g. z < −250). */
  passed:
    (axis: 'x' | 'y' | 'z', op: '<' | '>', value: number): Condition =>
    (s) =>
      op === '<' ? s.vehicle.position[axis] < value : s.vehicle.position[axis] > value,
  /** Arc length along `frames` beyond `sMeters` (nearest-frame projection). */
  trackProgress: (frames: TrackFrame[] | TrackFrame[][], sMeters: number): Condition => {
    const tracker = new TrackTracker(frames);
    return (s) => tracker.update(s.vehicle.position).s >= sMeters;
  },
  and:
    (...cs: Condition[]): Condition =>
    (s, c) =>
      cs.every((f) => f(s, c)),
  or:
    (...cs: Condition[]): Condition =>
    (s, c) =>
      cs.some((f) => f(s, c)),
  not:
    (f: Condition): Condition =>
    (s, c) =>
      !f(s, c),
};

/* ------------------------------------------------------------------ */
/* Track tracking                                                      */
/* ------------------------------------------------------------------ */

const _rel = new Vector3();
const _fwd = new Vector3();

/**
 * Nearest-frame tracker along a centerline with coherent (O(1) amortized) search. Accepts several
 * frame lists (e.g. runway + crescent); duplicated junction frames are merged and the arc length is
 * continuous across lists.
 */
export class TrackTracker {
  /** Beyond this distance (m²) from the tracked frame the tracker re-acquires globally. */
  static RECOVER_DIST2 = 30 * 30;
  readonly frames: TrackFrame[];
  private readonly cum: number[];
  private index = -1;

  constructor(frames: TrackFrame[] | TrackFrame[][]) {
    const lists = (Array.isArray(frames[0]) ? frames : [frames]) as TrackFrame[][];
    const out: TrackFrame[] = [];
    for (const list of lists)
      for (const f of list) {
        const prev = out[out.length - 1];
        if (!prev || prev.position.distanceToSquared(f.position) > 1e-6) out.push(f);
      }
    this.frames = out;
    this.cum = new Array(out.length);
    let acc = 0;
    for (let k = 0; k < out.length; k++) {
      if (k > 0) acc += out[k].position.distanceTo(out[k - 1].position);
      this.cum[k] = acc;
    }
  }

  /** Updates the nearest frame for `p`; returns it with its continuous arc length `s` (m). */
  update(p: Vector3): { frame: TrackFrame; index: number; s: number } {
    const f = this.frames;
    if (this.index < 0) {
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < f.length; i++) {
        const d = f[i].position.distanceToSquared(p);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      this.index = best;
    } else if (f[this.index].position.distanceToSquared(p) > TrackTracker.RECOVER_DIST2) {
      // far from the tracked frame (sim reset, teleport, fell off): global re-acquire
      this.index = -1;
      return this.update(p);
    } else {
      // local search in a small window around the previous index (stays on the right branch of
      // self-overlapping shapes such as the crescent, where the beam passes over the runway)
      const W = 6;
      let i = this.index;
      for (let iter = 0; iter < 32; iter++) {
        let best = i;
        let bestD = f[i].position.distanceToSquared(p);
        const lo = Math.max(0, i - W);
        const hi = Math.min(f.length - 1, i + W);
        for (let k = lo; k <= hi; k++) {
          const d = f[k].position.distanceToSquared(p);
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        }
        if (best === i) break;
        i = best;
      }
      this.index = i;
    }
    return { frame: f[this.index], index: this.index, s: this.cum[this.index] };
  }

  /** Arc length of frame i (m). */
  arcLength(i: number): number {
    return this.cum[Math.max(0, Math.min(this.cum.length - 1, i))];
  }

  /** Frame `meters` further along the track from index i (clamped). */
  ahead(i: number, meters: number): TrackFrame {
    const f = this.frames;
    const target = this.cum[i] + meters;
    let j = i;
    while (j + 1 < f.length && this.cum[j + 1] < target) j++;
    return f[Math.min(f.length - 1, j + 1)];
  }

  /** Total length (m). */
  get length(): number {
    return this.cum[this.cum.length - 1] ?? 0;
  }
}

/* ------------------------------------------------------------------ */
/* Closed-loop controllers                                             */
/* ------------------------------------------------------------------ */

const clamp1 = (x: number) => Math.max(-1, Math.min(1, x));

export interface FollowTrackOptions {
  /** Lateral offset gain (steer per meter). */
  lateralGain?: number;
  /** Heading error gain (steer per radian). */
  headingGain?: number;
  /** Lateral velocity damping (steer per m/s). */
  dampingGain?: number;
  /** Look-ahead distance (m) = base + speed · time. */
  lookaheadBase?: number;
  lookaheadTime?: number;
  /** Throttle per m/s of speed error. */
  speedGain?: number;
  /** Lateral target offset from the centerline (m, + = right). */
  offset?: number;
}

/**
 * Keeps the car centered on a ribbon centerline at `targetSpeed` (m/s, or a function of arc length).
 * Only drives while wheels touch: in the air it outputs nothing (throttle/steer mean pitch/yaw there).
 */
export function followTrack(
  frames: TrackFrame[] | TrackFrame[][],
  targetSpeed: number | ((s: number, snap: SimSnapshot) => number),
  opts: FollowTrackOptions = {},
): Controller {
  const tracker = new TrackTracker(frames);
  const kLat = opts.lateralGain ?? 0.12;
  const kHead = opts.headingGain ?? 1.6;
  const kDamp = opts.dampingGain ?? 0.05;
  const kSpeed = opts.speedGain ?? 0.35;
  const offset = opts.offset ?? 0;
  return (snap) => {
    const v = snap.vehicle;
    const near = tracker.update(v.position);
    if (v.groundedWheels === 0 || v.airborne) return {};
    const f = near.frame;
    const look = tracker.ahead(near.index, (opts.lookaheadBase ?? 3) + Math.abs(v.forwardSpeed) * (opts.lookaheadTime ?? 0.25));
    const lateral = _rel.subVectors(v.position, f.position).dot(f.right) - offset;
    // heading error in the look-ahead frame's plane: + = car points right of the track
    _fwd.copy(v.forward).addScaledVector(look.up, -v.forward.dot(look.up));
    const heading = Math.atan2(_fwd.dot(look.right), _fwd.dot(look.forward));
    const latVel = v.velocity.dot(f.right);
    const steer = clamp1(-(kLat * lateral + kHead * heading + kDamp * latVel));
    const target = typeof targetSpeed === 'number' ? targetSpeed : targetSpeed(near.s, snap);
    const throttle = clamp1((target - v.forwardSpeed) * kSpeed);
    return { steer, throttle };
  };
}

/** Holds boost until `until` becomes true once (then never again during this run). */
export function holdBoostUntil(until: Condition): Controller {
  let finished = false;
  let run = -1;
  return (snap, ctx) => {
    if (ctx.runId !== run) {
      run = ctx.runId;
      finished = false;
    }
    if (!finished && until(snap, ctx)) finished = true;
    return { boost: !finished };
  };
}

/** Holds the stabilizer whenever the car is airborne. */
export function stabilizeInAir(): Controller {
  return (snap) => ({ stabilize: snap.vehicle.airborne });
}

/** Holds the vacuum while `when` holds. */
export function holdVacuumWhile(when: Condition): Controller {
  return (snap, ctx) => ({ vacuum: when(snap, ctx) });
}

const _err = new Vector3();
const UP = new Vector3(0, 1, 0);

/**
 * Uses roll (Q/E) and pitch (W/S) like a player to bring the chassis upright — toward the predicted
 * landing normal when available, else world up. Only acts in the air.
 */
export function rollToUpright(opts: { gain?: number; damping?: number; pitch?: boolean } = {}): Controller {
  const kp = opts.gain ?? 2.2;
  const kd = opts.damping ?? 0.45;
  return (snap) => {
    const v = snap.vehicle;
    if (!v.airborne) return {};
    const target = snap.prediction?.valid ? snap.prediction.normal : UP;
    _err.crossVectors(v.up, target);
    const c = v.up.dot(target);
    // signed angles about forward (roll) and right (pitch); E rolls the top toward the right
    const rollErr = Math.atan2(_err.dot(v.forward), c);
    // when (nearly) inverted, roll first: pitching at the same time would tumble diagonally
    const pitchErr = Math.abs(rollErr) > 1.2 ? 0 : Math.atan2(_err.dot(v.right), c);
    const wRoll = v.angularVelocity.dot(v.forward);
    const wPitch = v.angularVelocity.dot(v.right);
    const out: Partial<InputState> = { roll: clamp1(kp * rollErr - kd * wRoll) };
    // nose up (S, throttle −1) rotates up about +right
    if (opts.pitch !== false) out.throttle = -clamp1(kp * pitchErr - kd * wPitch);
    return out;
  };
}

export type RotationAxis = 'pitch' | 'yaw' | 'roll';

/**
 * Rotates `n` full turns about one axis with the player controls, releasing early (`leadDeg`) so
 * the damping stops the rotation close to the target. Direction: +1 = backflip / spin left /
 * roll right, −1 = frontflip / spin right / roll left. Air only.
 */
export function rotateNTimes(axis: RotationAxis, n: number, direction: 1 | -1, leadDeg = 50): Controller {
  return (snap) => {
    if (!snap.air.airborne) return {};
    const acc = Math.abs(snap.air.rotation[axis]);
    if (acc >= n * 360 - leadDeg) return {};
    if (axis === 'pitch') return { throttle: -direction }; // S = nose up = backflip
    if (axis === 'yaw') return { steer: -direction }; // A = yaw left
    return { roll: direction }; // E = roll right
  };
}

/** `n` front- or backflips (W / S held until the rotation is nearly complete). */
export function flipNTimes(n: number, kind: 'front' | 'back', leadDeg = 50): Controller {
  return rotateNTimes('pitch', n, kind === 'back' ? 1 : -1, leadDeg);
}

/** Input timeline by phase time: each step applies from `at` seconds until the next step. */
export function timeline(steps: { at: number; input: Partial<InputState> }[]): Controller {
  const sorted = [...steps].sort((a, b) => a.at - b.at);
  return (_s, ctx) => {
    let cur: Partial<InputState> = {};
    for (const st of sorted) if (ctx.phaseTime >= st.at) cur = st.input;
    return cur;
  };
}

/** Merges controllers (later wins per field). */
export function combine(...controllers: Controller[]): Controller {
  return (snap, ctx) => {
    const out: Partial<InputState> = {};
    for (const c of controllers) Object.assign(out, c(snap, ctx));
    return out;
  };
}

/** Constant input as a controller. */
export function constant(input: Partial<InputState>): Controller {
  return () => input;
}
