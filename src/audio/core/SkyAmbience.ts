/**
 * High-altitude sky ambience: a soft, slowly gusting wind bed that gives the menus and the floating
 * facility a sense of height and open air. It is band-limited pink noise whose centre frequency and level
 * drift with incommensurate LFOs (so it never audibly loops), and it needs no per-frame work, so it keeps
 * going on screens that never call update().
 *
 * Routed through the music bus: it follows the music volume and is muffled with the score on pause.
 */
export class SkyAmbience {
  private readonly ctx: BaseAudioContext;
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly out: GainNode;

  constructor(ctx: BaseAudioContext, pink: AudioBuffer, dest: AudioNode, rng: () => number) {
    this.ctx = ctx;
    const src = ctx.createBufferSource();
    src.buffer = pink;
    src.loop = true;
    src.start(0, rng() * pink.duration * 0.9);
    this.track(src);

    const bp = this.node(ctx.createBiquadFilter());
    bp.type = 'bandpass';
    bp.frequency.value = 380;
    bp.Q.value = 0.55;
    const lp = this.node(ctx.createBiquadFilter());
    lp.type = 'lowpass';
    lp.frequency.value = 1600;
    lp.Q.value = 0.5;
    // A faint high "sheen" for openness.
    const hp = this.node(ctx.createBiquadFilter());
    hp.type = 'highpass';
    hp.frequency.value = 3000;
    const sheen = this.node(ctx.createGain());
    sheen.gain.value = 0.05;
    const gust = this.node(ctx.createGain());
    gust.gain.value = 0.68;
    this.out = this.node(ctx.createGain());
    this.out.gain.value = 0;

    src.connect(bp).connect(lp).connect(gust);
    src.connect(hp).connect(sheen).connect(gust);
    gust.connect(this.out).connect(dest);

    // Centre-frequency drift (two slow LFOs) and gusts (two more) — never repeating exactly. Slow
    // modulation → k-rate (coefficients once per render quantum).
    for (const p of [bp.frequency, gust.gain]) {
      try {
        p.automationRate = 'k-rate';
      } catch {
        /* keep a-rate */
      }
    }
    this.lfo(0.047, 140, bp.frequency);
    this.lfo(0.031, 90, bp.frequency);
    this.lfo(0.12, 0.2, gust.gain);
    this.lfo(0.071, 0.1, gust.gain);
  }

  /** Overall bed level (linear). */
  setLevel(level: number, t: number, tc: number): void {
    this.out.gain.setTargetAtTime(Math.max(0, level), t, Math.max(0.001, tc));
  }

  dispose(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* ignore */
      }
    }
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.sources.length = 0;
    this.nodes.length = 0;
  }

  private lfo(freq: number, depth: number, target: AudioParam): void {
    const o = this.ctx.createOscillator();
    o.frequency.value = freq;
    const g = this.node(this.ctx.createGain());
    g.gain.value = depth;
    o.connect(g).connect(target);
    o.start(0);
    this.track(o);
  }

  private node<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  private track(s: AudioScheduledSourceNode): void {
    this.nodes.push(s);
    this.sources.push(s);
  }
}
