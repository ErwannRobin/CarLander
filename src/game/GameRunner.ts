/**
 * GameRunner — owns the active GameSim, steps it at a fixed rate with interpolation, applies the
 * sim's requested time scale, publishes the render frame + events, and handles crash auto-restart.
 * UI / store wiring lives in render/scenes/GameController.tsx so this class stays framework-free.
 */
import { GameSim } from '@/game/sim/GameSim';
import { InputLog, LOG_TAIL_TICKS, planClip, slowMotionAt, type ReplayClip, type ReplayMoment } from './replay';
import { runtime } from './runtime';
import { TUNING } from './tuning';
import { NEUTRAL_INPUT, type GameEvent, type InputState, type LevelDef } from './types';

export interface RunnerHooks {
  /** Sample player input for one tick. */
  sampleInput(): InputState;
  /** Called for every sim event after it was published on runtime.events. */
  onEvent?(e: GameEvent): void;
  /** Called when the crash auto-restart delay elapsed. */
  requestRestart?(): void;
  /** Called ~30 times per second with the current snapshot (HUD). */
  publishHud?(): void;
  /** The start countdown moved to `step` (3, 2, 1), reached GO (0) or was cut off (null). */
  onCountdown?(step: number | null): void;
  /** Called for every event of a replay (on runtime.events already). Never for the live run. */
  onReplayEvent?(e: GameEvent): void;
  /** The replay changed phase, or (~15 times per second) moved on. */
  onReplay?(status: ReplayStatus): void;
}

export type ReplayPhase = 'seeking' | 'playing' | 'ended';

export interface ReplayStatus {
  phase: ReplayPhase;
  /** 0..1 while re-simulating up to the start of the clip. */
  seek: number;
  /** 0..1 position in the clip. */
  progress: number;
  /** Time scale currently applied (director slow motion x sim slow motion x speed). */
  scale: number;
}

export interface ReplayOptions {
  /** Director slow motion around landings and the finish. */
  autoSlowmo: boolean;
  /** Manual speed multiplier (1, 0.5, 0.25). */
  speed: number;
  paused: boolean;
}

/** Wall-clock budget per frame for re-simulating up to the start of the clip (ms). */
const SEEK_BUDGET_MS = 10;

interface ReplayRun {
  sim: GameSim;
  clip: ReplayClip;
  phase: ReplayPhase;
  tick: number;
  acc: number;
  assist: boolean;
  scale: number;
  opts: ReplayOptions;
  hudClock: number;
}

const CRASH_RESTART_DELAY = 1.7; // real seconds
/** 3-2-1 before every departure: seconds per number on the first start of a level, and on retries. */
export const COUNTDOWN_STEPS = 3;
const COUNTDOWN_STEP_FIRST = 1;
const COUNTDOWN_STEP_RETRY = 0.65;
const HUD_INTERVAL = 1 / 30;

export class GameRunner {
  sim: GameSim | null = null;
  level: LevelDef | null = null;
  paused = false;
  /** Off: the car drives away at once (QA and screenshot scripts). */
  countdownEnabled = true;
  private acc = 0;
  private crashClock = -1;
  private hudClock = 0;
  private attempts = new Map<number, number>();
  private flightAssist = true;
  /** Real seconds of countdown left (0 = driving) and the length of one number. */
  private countdownLeft = 0;
  private countdownStep = COUNTDOWN_STEP_FIRST;
  private countdownShown: number | null = null;
  /** Everything a replay needs from the live run: the input of each tick and the moments to slow down for. */
  private readonly log = new InputLog();
  private moments: ReplayMoment[] = [];
  private completeTick = -1;
  private runFirstAttempt = true;
  private replay: ReplayRun | null = null;

  constructor(private hooks: RunnerHooks) {}

  load(level: LevelDef) {
    this.disposeSim();
    const prev = this.attempts.get(level.id) ?? 0;
    this.attempts.set(level.id, prev + 1);
    this.level = level;
    runtime.level = level;
    this.runFirstAttempt = prev === 0;
    this.sim = new GameSim(level, { firstAttempt: prev === 0, flightAssist: this.flightAssist });
    this.afterReset(COUNTDOWN_STEP_FIRST);
  }

  restart() {
    if (!this.sim || !this.level) return;
    const prev = this.attempts.get(this.level.id) ?? 0;
    this.attempts.set(this.level.id, prev + 1);
    this.runFirstAttempt = false;
    this.sim.setOptions({ firstAttempt: false, flightAssist: this.flightAssist });
    this.sim.reset();
    this.afterReset(COUNTDOWN_STEP_RETRY);
  }

  setFlightAssist(on: boolean) {
    this.flightAssist = on;
    this.sim?.setOptions({ flightAssist: on });
  }

  /** True while the start countdown holds the car at the line. */
  get counting(): boolean {
    return this.countdownLeft > 0;
  }

  private setCountdownShown(step: number | null) {
    if (step === this.countdownShown) return;
    this.countdownShown = step;
    this.hooks.onCountdown?.(step);
  }

  private afterReset(countdownStep: number) {
    this.stopReplay();
    this.log.clear();
    this.moments = [];
    this.completeTick = -1;
    this.acc = 0;
    this.crashClock = -1;
    this.countdownStep = countdownStep;
    this.countdownLeft = this.countdownEnabled ? countdownStep * COUNTDOWN_STEPS : 0;
    this.countdownShown = null;
    if (this.countdownEnabled) this.setCountdownShown(COUNTDOWN_STEPS);
    this.hudClock = HUD_INTERVAL;
    runtime.runId++;
    this.flushEvents();
    this.publishFrame(0, runtime.frame.time, 1);
    this.hooks.publishHud?.();
  }

  private flushEvents() {
    if (!this.sim) return;
    for (const e of this.sim.drainEvents()) {
      runtime.events.emit(e);
      if (e.type === 'crash') this.crashClock = 0;
      else if (e.type === 'landing') this.moments.push({ tick: this.sim.snapshot.tick, floor: e.result.quality === 'perfect' ? 0.3 : 0.45 });
      else if (e.type === 'levelComplete') {
        this.completeTick = this.sim.snapshot.tick;
        this.moments.push({ tick: this.completeTick, floor: 0.4 });
      }
      this.hooks.onEvent?.(e);
    }
  }

  /** Called once per rendered frame. */
  update(realDt: number, time: number) {
    const dt = Math.min(0.1, Math.max(0, realDt));
    if (this.replay) {
      this.updateReplay(dt, time);
      return;
    }
    const sim = this.sim;
    if (!sim) {
      runtime.frame.dt = dt;
      runtime.frame.simDt = 0;
      runtime.frame.time = time;
      runtime.frame.paused = true;
      return;
    }
    let simDt = 0;
    if (!this.paused && this.countdownLeft > 0) {
      // 3 - 2 - 1: the car waits at the line, the world and the camera keep moving
      this.countdownLeft = Math.max(0, this.countdownLeft - dt);
      if (this.countdownLeft > 0) this.setCountdownShown(Math.max(1, Math.ceil(this.countdownLeft / this.countdownStep - 1e-9)));
      else this.setCountdownShown(0);
    } else if (!this.paused) {
      const scale = Math.min(1, Math.max(0.05, sim.snapshot.timeScale || 1));
      simDt = dt * scale;
      this.acc += simDt;
      let ticks = 0;
      while (this.acc >= TUNING.dt && ticks < TUNING.maxTicksPerFrame) {
        const phase = sim.snapshot.phase;
        let input: InputState;
        if (phase === 'complete') {
          // roll to a gentle stop on the finish deck
          input = { ...NEUTRAL_INPUT, throttle: sim.snapshot.vehicle.forwardSpeed > 1 ? -0.45 : 0 };
        } else if (phase === 'crashed') {
          input = NEUTRAL_INPUT;
        } else {
          input = this.hooks.sampleInput();
        }
        if (this.completeTick < 0 || this.log.length < this.completeTick + LOG_TAIL_TICKS) this.log.push(input, this.flightAssist);
        sim.step(input);
        this.flushEvents();
        this.acc -= TUNING.dt;
        ticks++;
      }
      if (ticks >= TUNING.maxTicksPerFrame) this.acc = 0;

      if (this.crashClock >= 0) {
        this.crashClock += dt;
        if (this.crashClock >= CRASH_RESTART_DELAY) {
          this.crashClock = -1;
          if (this.hooks.requestRestart) this.hooks.requestRestart();
          else this.restart();
        }
      }
    }
    this.publishFrame(dt, time, Math.min(1, this.acc / TUNING.dt), simDt);
    this.hudClock += dt;
    if (this.hudClock >= HUD_INTERVAL) {
      this.hudClock = 0;
      this.hooks.publishHud?.();
    }
  }

  private publishFrame(dt: number, time: number, alpha: number, simDt = 0, sim: GameSim | null = this.sim) {
    if (!sim) return;
    const f = runtime.frame;
    f.snapshot = sim.snapshot;
    f.position.lerpVectors(sim.prevPose.position, sim.currPose.position, alpha);
    f.quaternion.slerpQuaternions(sim.prevPose.quaternion, sim.currPose.quaternion, alpha);
    f.alpha = alpha;
    f.dt = dt;
    f.simDt = simDt;
    f.time = time;
    f.paused = this.paused;
  }

  /** The sim whose pose is on screen (the replay's while one runs). Cameras raycast against it. */
  get activeSim(): GameSim | null {
    return this.replay && this.replay.phase !== 'seeking' ? this.replay.sim : this.sim;
  }

  /** True when the finished run can be replayed (the level was completed and its inputs were logged). */
  get canReplay(): boolean {
    return !!this.sim && !!this.level && this.completeTick >= 0 && this.log.length > 0;
  }

  get replaying(): boolean {
    return this.replay !== null;
  }

  /** Start (or restart from the top of the clip) the replay of the last seconds of the finished run. */
  startReplay(opts: ReplayOptions) {
    if (!this.canReplay || !this.level) return;
    const prev = this.replay?.opts ?? opts;
    this.disposeReplay();
    const clip = planClip(this.log.length, this.completeTick, this.moments);
    const probe = { ...NEUTRAL_INPUT };
    const assist = this.log.length > 0 ? this.log.read(0, probe) : this.flightAssist;
    const sim = new GameSim(this.level, { firstAttempt: this.runFirstAttempt, flightAssist: assist });
    sim.drainEvents();
    this.replay = { sim, clip, phase: 'seeking', tick: 0, acc: 0, assist, scale: 1, opts: { ...prev, ...opts }, hudClock: 0 };
    runtime.replay.active = true;
    this.notifyReplay();
  }

  setReplayOptions(opts: Partial<ReplayOptions>) {
    if (this.replay) Object.assign(this.replay.opts, opts);
  }

  /** Leave the replay; the finished run is untouched and shows again. */
  stopReplay() {
    if (!this.replay) return;
    this.disposeReplay();
    runtime.replay.active = false;
    runtime.runId++;
    this.acc = 0;
    this.publishFrame(0, runtime.frame.time, 1);
  }

  private disposeReplay() {
    this.replay?.sim.dispose();
    this.replay = null;
  }

  private notifyReplay() {
    const r = this.replay;
    if (!r) return;
    const span = Math.max(1, r.clip.end - r.clip.start);
    this.hooks.onReplay?.({
      phase: r.phase,
      seek: r.clip.start > 0 ? Math.min(1, r.tick / r.clip.start) : 1,
      progress: r.phase === 'seeking' ? 0 : Math.min(1, (r.tick - r.clip.start) / span),
      scale: r.scale,
    });
  }

  private flushReplayEvents(sim: GameSim) {
    for (const e of sim.drainEvents()) {
      runtime.events.emit(e);
      this.hooks.onReplayEvent?.(e);
    }
  }

  private updateReplay(dt: number, time: number) {
    const r = this.replay;
    if (!r) return;
    const sim = r.sim;
    const input = this.replayInput;
    let simDt = 0;
    let phaseChanged = false;

    if (r.phase === 'seeking') {
      // silently re-simulate up to the start of the clip, a slice per frame so the page stays alive
      const t0 = performance.now();
      while (r.tick < r.clip.start && performance.now() - t0 < SEEK_BUDGET_MS) {
        this.stepReplay(r, input);
        sim.drainEvents();
      }
      if (r.tick >= r.clip.start) {
        r.phase = 'playing';
        r.acc = 0;
        phaseChanged = true;
        runtime.runId++;
        runtime.events.emit({ type: 'reset' });
        this.hooks.onReplayEvent?.({ type: 'reset' });
        sim.prevPose.position.copy(sim.currPose.position);
        sim.prevPose.quaternion.copy(sim.currPose.quaternion);
      }
    } else if (r.phase === 'playing' && !r.opts.paused) {
      const director = r.opts.autoSlowmo ? slowMotionAt(r.tick + r.acc / TUNING.dt, r.clip.moments) : 1;
      r.scale = Math.max(0.03, Math.min(sim.snapshot.timeScale || 1, director)) * r.opts.speed;
      simDt = dt * r.scale;
      r.acc += simDt;
      let ticks = 0;
      while (r.acc >= TUNING.dt && r.tick < r.clip.end && ticks < TUNING.maxTicksPerFrame) {
        this.stepReplay(r, input);
        this.flushReplayEvents(sim);
        r.acc -= TUNING.dt;
        ticks++;
      }
      if (ticks >= TUNING.maxTicksPerFrame) r.acc = 0;
      if (r.tick >= r.clip.end) {
        r.phase = 'ended';
        r.acc = 0;
        simDt = 0;
        phaseChanged = true;
      }
    }

    // while seeking, the finished run stays on screen behind the "preparing" card
    if (r.phase === 'seeking') this.publishFrame(dt, time, 1, 0, this.sim);
    else this.publishFrame(dt, time, r.phase === 'ended' ? 1 : Math.min(1, r.acc / TUNING.dt), simDt, sim);
    runtime.frame.paused = r.opts.paused && r.phase === 'playing';

    r.hudClock += dt;
    if (phaseChanged || r.hudClock >= 1 / 15) {
      r.hudClock = 0;
      this.notifyReplay();
    }
  }

  private readonly replayInput: InputState = { ...NEUTRAL_INPUT };

  private stepReplay(r: ReplayRun, input: InputState) {
    const assist = this.log.read(r.tick, input);
    if (assist !== r.assist) {
      r.assist = assist;
      r.sim.setOptions({ flightAssist: assist });
    }
    r.sim.step(input);
    r.tick++;
  }

  /** Skip the remaining crash delay (R / action key during the crash). */
  get crashed(): boolean {
    return this.crashClock >= 0;
  }

  private disposeSim() {
    this.sim?.dispose();
    this.sim = null;
  }

  dispose() {
    this.disposeReplay();
    runtime.replay.active = false;
    this.countdownLeft = 0;
    this.setCountdownShown(null);
    this.disposeSim();
    runtime.level = null;
  }
}
