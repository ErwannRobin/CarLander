import type {
  GameEvent,
  InputState,
  LevelDef,
  ObjectiveContext,
  ObjectiveDef,
  ObjectiveState,
  PromptState,
  SimSnapshot,
} from '../types';

/**
 * Ordered objective list + tutorial prompts (ARCHITECTURE §7).
 *
 * Each tick (after physics + events) the active objective's `complete(ctx)` is evaluated; on
 * completion `objectiveComplete` is emitted and the next objective becomes active (`objective`).
 * The active objective's `prompt` is shown while `when(ctx)` holds; `slowMo` (first attempt only)
 * requests bullet-time while the prompt is visible.
 *
 * The final objective is the level finish: the sim completes it on level completion (a qualifying
 * landing in `finish.zoneId`), and its own `complete()` may also mark it done earlier.
 */
export class ObjectiveRunner {
  readonly state: ObjectiveState;
  private readonly defs: ObjectiveDef[];
  private index = 0;
  private activeSince = 0;
  private prompt: PromptState | null = null;
  /** Objective whose prompt is shown (prompt text is static per objective ⇒ identity is the key). */
  private promptOwner: ObjectiveDef | null = null;
  private memory: Record<string, number | boolean | string> = {};
  private firstAttempt: boolean;
  private slowMo = 1;
  private readonly ctx: ObjectiveContext;
  private ctxEvents: readonly GameEvent[] = [];
  private inZoneFn: (id: string) => boolean = () => false;

  constructor(level: LevelDef, firstAttempt: boolean, state: ObjectiveState) {
    this.defs = level.objectives;
    this.firstAttempt = firstAttempt;
    this.state = state;
    const self = this;
    // Stable context object (no per-tick allocation); fields are refreshed before each evaluation.
    this.ctx = {
      snapshot: undefined as unknown as SimSnapshot,
      input: undefined as unknown as InputState,
      get events() {
        return self.ctxEvents;
      },
      inZone: (id: string) => self.inZoneFn(id),
      objectiveTime: 0,
      get memory() {
        return self.memory;
      },
      get firstAttempt() {
        return self.firstAttempt;
      },
    } as ObjectiveContext;
  }

  /** Restarts at the first objective; emits its `objective` event. */
  reset(firstAttempt: boolean, time: number, events: GameEvent[]): void {
    this.firstAttempt = firstAttempt;
    this.index = 0;
    this.activeSince = time;
    this.memory = {};
    this.prompt = null;
    this.promptOwner = null;
    this.slowMo = 1;
    this.publish(false);
    this.announce(events);
  }

  setFirstAttempt(v: boolean): void {
    this.firstAttempt = v;
  }

  get currentIndex(): number {
    return this.index;
  }

  get total(): number {
    return this.defs.length;
  }

  /** True when every objective before the final one is complete. */
  get readyForFinish(): boolean {
    return this.index >= this.defs.length - 1;
  }

  get currentPrompt(): PromptState | null {
    return this.prompt;
  }

  /** Requested time scale from a tutorial prompt (1 when none). */
  get requestedTimeScale(): number {
    return this.slowMo;
  }

  /**
   * Evaluates objectives and prompts for this tick.
   * @param tickEvents events emitted by the sim during this tick (before objectives run)
   * @param out where objective/prompt events are appended
   */
  update(
    snapshot: SimSnapshot,
    input: InputState,
    tickEvents: readonly GameEvent[],
    inZone: (id: string) => boolean,
    time: number,
    out: GameEvent[],
  ): void {
    this.ctxEvents = tickEvents;
    this.inZoneFn = inZone;
    const ctx = this.ctx;
    ctx.snapshot = snapshot;
    ctx.input = input;

    // Advance through objectives that complete this tick (at most one per tick keeps events readable).
    if (this.index < this.defs.length) {
      ctx.objectiveTime = time - this.activeSince;
      const def = this.defs[this.index];
      let done = false;
      try {
        done = def.complete(ctx);
      } catch (err) {
        // A faulty level predicate must not take the sim down.
        console.error(`[objectives] ${def.id}.complete threw`, err);
      }
      if (done) this.completeCurrent(time, out);
    }

    // Prompt for the (possibly new) active objective.
    let owner: ObjectiveDef | null = null;
    let slow = 1;
    const def = this.index < this.defs.length ? this.defs[this.index] : null;
    if (def?.prompt) {
      ctx.objectiveTime = time - this.activeSince;
      let show = true;
      try {
        show = def.prompt.when ? def.prompt.when(ctx) : true;
      } catch (err) {
        console.error(`[objectives] ${def.id}.prompt.when threw`, err);
        show = false;
      }
      if (show) {
        owner = def;
        if (this.firstAttempt && def.prompt.slowMo !== undefined) slow = Math.min(1, Math.max(0.05, def.prompt.slowMo));
      }
    }
    if (owner !== this.promptOwner) {
      // a new PromptState only when the prompt actually changes (stable object while it is shown)
      const p = owner?.prompt;
      const next: PromptState | null =
        owner && p ? { id: owner.id, text: p.text, hint: p.hint ?? null, tone: p.tone ?? 'action' } : null;
      this.prompt = next;
      this.promptOwner = owner;
      out.push({ type: 'prompt', prompt: next ? { ...next } : null });
    }
    this.slowMo = slow;
  }

  /** Marks the active objective complete (used by the sim for the final/finish objective). */
  completeCurrent(time: number, out: GameEvent[]): void {
    if (this.index >= this.defs.length) return;
    const def = this.defs[this.index];
    out.push({ type: 'objectiveComplete', index: this.index, id: def.id });
    this.index++;
    this.activeSince = time;
    if (this.index < this.defs.length) {
      this.publish(false);
      this.announce(out);
    } else {
      this.publish(true);
    }
  }

  /** Completes all remaining objectives (level complete). */
  completeAll(time: number, out: GameEvent[]): void {
    while (this.index < this.defs.length) this.completeCurrent(time, out);
  }

  private announce(out: GameEvent[]): void {
    if (this.index >= this.defs.length) return;
    const def = this.defs[this.index];
    out.push({ type: 'objective', index: this.index, id: def.id, title: def.title });
  }

  private publish(allDone: boolean): void {
    const s = this.state;
    s.total = this.defs.length;
    if (this.defs.length === 0) {
      s.index = 0;
      s.id = '';
      s.title = '';
      s.text = '';
      s.hints = [];
      s.complete = allDone;
      return;
    }
    const i = Math.min(this.index, this.defs.length - 1);
    const def = this.defs[i];
    s.index = i;
    s.id = def.id;
    s.title = def.title;
    s.text = def.text;
    s.hints = def.hints;
    s.complete = allDone;
  }
}
