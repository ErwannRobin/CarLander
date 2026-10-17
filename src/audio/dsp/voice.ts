/**
 * Self-cleaning voice: a bag of nodes created for one sound (a one-shot, a music note, a sustained pad).
 * Every source registers `onended`; when the last source has ended, all nodes are disconnected and the
 * owner is notified (so pools can track polyphony). Nothing has to be cleaned up by hand.
 */

export class Voice {
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly finalizers: Array<() => void> = [];
  private live = 0;
  private stopped = false;
  private finished = false;
  /** Latest scheduled stop time among all sources (Infinity while a sustained voice is unreleased). */
  stopTime = 0;

  constructor(
    readonly ctx: BaseAudioContext,
    readonly startTime: number,
    private readonly onFinished?: (v: Voice) => void,
    /** 0 = expendable, 1 = normal, 2 = critical / sustained (never stolen). */
    readonly priority: 0 | 1 | 2 = 1,
  ) {}

  get isFinished(): boolean {
    return this.finished;
  }

  /** Track an externally created node for disconnection at the end. */
  own<T extends AudioNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }

  gain(value = 1): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = value;
    return this.own(g);
  }

  filter(type: BiquadFilterType, frequency: number, q = 0.707, gainDb = 0): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = frequency;
    f.Q.value = q;
    f.gain.value = gainDb;
    return this.own(f);
  }

  pan(value: number): StereoPannerNode {
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, value));
    return this.own(p);
  }

  shaper(curve: Float32Array<ArrayBuffer>, oversample: OverSampleType = 'none'): WaveShaperNode {
    const s = this.ctx.createWaveShaper();
    s.curve = curve;
    s.oversample = oversample;
    return this.own(s);
  }

  /** Oscillator started at `start`; pass `stop = Infinity` for a sustained voice released later. */
  osc(type: OscillatorType | PeriodicWave, frequency: number, start: number, stop: number, detune = 0): OscillatorNode {
    const o = this.ctx.createOscillator();
    if (typeof type === 'string') o.type = type as OscillatorType; // PeriodicWave is structurally empty, so narrowing yields `string`
    else o.setPeriodicWave(type);
    o.frequency.value = frequency;
    o.detune.value = detune;
    this.track(o, start, stop);
    return o;
  }

  /** Buffer source (noise etc.). Random `offset` decorrelates successive one-shots. */
  buffer(
    buf: AudioBuffer,
    start: number,
    stop: number,
    opts: { rate?: number; loop?: boolean; offset?: number } = {},
  ): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = opts.loop ?? true;
    s.playbackRate.value = opts.rate ?? 1;
    this.track(s, start, stop, Math.max(0, Math.min(buf.duration - 0.01, opts.offset ?? 0)));
    return s;
  }

  /** Run `fn` when the voice is torn down (e.g. disconnect from a shared LFO). */
  onFinish(fn: () => void): void {
    this.finalizers.push(fn);
  }

  /** Schedule all sources to stop at `t` (used to end sustained voices after their release). */
  stopAll(t: number): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopTime = t;
    for (const s of this.sources) {
      try {
        s.stop(t);
      } catch {
        /* already stopped */
      }
    }
  }

  /** Abort immediately and tear down (sources not yet started never sound). */
  cancel(): void {
    this.stopped = true;
    for (const s of this.sources) {
      try {
        s.stop(0);
      } catch {
        /* ignore */
      }
    }
    // Do not wait for `ended` (not guaranteed for never-started sources in every engine).
    this.finish();
  }

  private track(src: AudioScheduledSourceNode, start: number, stop: number, offset = 0): void {
    this.nodes.push(src);
    this.sources.push(src);
    this.live++;
    src.onended = () => {
      if (--this.live <= 0) this.finish();
    };
    if (src instanceof AudioBufferSourceNode) src.start(start, offset);
    else src.start(start);
    if (Number.isFinite(stop)) {
      src.stop(Math.max(start + 0.001, stop));
      this.stopTime = Math.max(this.stopTime, stop);
    } else {
      this.stopTime = Infinity;
    }
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
    for (const fn of this.finalizers) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    this.nodes.length = 0;
    this.sources.length = 0;
    this.finalizers.length = 0;
    this.onFinished?.(this);
  }
}

/**
 * Polyphony bookkeeping for one family of voices (sfx, ui, music). When full, expendable requests are
 * refused; normal ones steal the oldest non-critical voice (or are refused); critical ones always play.
 * Critical / sustained voices (pads, landings, crash) are never stolen.
 */
export class VoicePool {
  private readonly active = new Set<Voice>();
  private readonly onEnd = (v: Voice) => this.active.delete(v);

  constructor(
    private readonly ctx: BaseAudioContext,
    readonly max: number,
  ) {}

  get size(): number {
    return this.active.size;
  }

  /** @param priority 0 = expendable (debris, hover), 1 = normal, 2 = critical */
  acquire(start: number, priority: 0 | 1 | 2 = 1): Voice | null {
    if (this.active.size >= this.max && priority < 2) {
      if (priority === 0) return null;
      let victim: Voice | null = null;
      for (const v of this.active) {
        if (v.priority < 2) {
          victim = v; // insertion order → oldest first
          break;
        }
      }
      if (!victim) return null;
      victim.cancel();
      this.active.delete(victim);
    }
    const v = new Voice(this.ctx, start, this.onEnd, priority);
    this.active.add(v);
    return v;
  }

  /** Cancel voices that have not started yet (start > t) — used when the music grid re-syncs. */
  cancelAfter(t: number): void {
    for (const v of this.active) {
      if (v.startTime > t) {
        v.cancel();
        this.active.delete(v);
      }
    }
  }

  cancelAll(): void {
    for (const v of this.active) v.cancel();
    this.active.clear();
  }
}
