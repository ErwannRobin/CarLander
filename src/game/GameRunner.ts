/**
 * GameRunner — owns the active GameSim, steps it at a fixed rate with interpolation, applies the
 * sim's requested time scale, publishes the render frame + events, and handles crash auto-restart.
 * UI / store wiring lives in render/scenes/GameController.tsx so this class stays framework-free.
 */
import { GameSim } from '@/game/sim/GameSim';
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
}

const CRASH_RESTART_DELAY = 1.7; // real seconds
const HUD_INTERVAL = 1 / 30;

export class GameRunner {
  sim: GameSim | null = null;
  level: LevelDef | null = null;
  paused = false;
  private acc = 0;
  private crashClock = -1;
  private hudClock = 0;
  private attempts = new Map<number, number>();
  private flightAssist = true;

  constructor(private hooks: RunnerHooks) {}

  load(level: LevelDef) {
    this.disposeSim();
    const prev = this.attempts.get(level.id) ?? 0;
    this.attempts.set(level.id, prev + 1);
    this.level = level;
    runtime.level = level;
    this.sim = new GameSim(level, { firstAttempt: prev === 0, flightAssist: this.flightAssist });
    this.afterReset();
  }

  restart() {
    if (!this.sim || !this.level) return;
    const prev = this.attempts.get(this.level.id) ?? 0;
    this.attempts.set(this.level.id, prev + 1);
    this.sim.setOptions({ firstAttempt: false, flightAssist: this.flightAssist });
    this.sim.reset();
    this.afterReset();
  }

  setFlightAssist(on: boolean) {
    this.flightAssist = on;
    this.sim?.setOptions({ flightAssist: on });
  }

  private afterReset() {
    this.acc = 0;
    this.crashClock = -1;
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
      this.hooks.onEvent?.(e);
    }
  }

  /** Called once per rendered frame. */
  update(realDt: number, time: number) {
    const dt = Math.min(0.1, Math.max(0, realDt));
    const sim = this.sim;
    if (!sim) {
      runtime.frame.dt = dt;
      runtime.frame.simDt = 0;
      runtime.frame.time = time;
      runtime.frame.paused = true;
      return;
    }
    let simDt = 0;
    if (!this.paused) {
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

  private publishFrame(dt: number, time: number, alpha: number, simDt = 0) {
    const sim = this.sim;
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

  /** Skip the remaining crash delay (R / action key during the crash). */
  get crashed(): boolean {
    return this.crashClock >= 0;
  }

  private disposeSim() {
    this.sim?.dispose();
    this.sim = null;
  }

  dispose() {
    this.disposeSim();
    runtime.level = null;
  }
}
