/**
 * ROADSTER FLIGHT — procedural audio engine (public API).
 *
 *   import { audio } from '@/audio/AudioEngine';
 *   button.onclick = () => { void audio.unlock(); audio.ui('start'); };   // first user gesture
 *   audio.setMix({ master, music, sfx, muted });                           // from Settings
 *   audio.setScene('game');                                               // title | game | paused | complete
 *   useFrame(() => audio.update(runtime.frame));                          // or <AudioDriver/>
 *   runtime.events.onAny(audio.handleEvent);                              // one-shots
 *
 * Everything is synthesised (oscillators, generated noise, filters, waveshapers, a convolver with a
 * generated impulse response) — no audio files. All calls are cheap no-ops until `unlock()` has created
 * the AudioContext (browsers require a user gesture); `setMix` / `setScene` made before that are stored
 * and applied on unlock. An unlock() issued without user activation (e.g. a touch `pointerdown`) defers
 * itself to the next activating gesture, and any later gesture or UI click resumes a context the browser
 * left suspended. The context is suspended while the tab is hidden and while muted.
 *
 * Scene semantics
 *   title     title score + sky ambience; vehicle layers silent; gameplay events ignored
 *   game      gameplay score (intensity from speed / airborne / boost) + vehicle layers + one-shots
 *   paused    score ducked & muffled, vehicle layers silent (also silent whenever frame.paused)
 *   complete  vehicle layers fade; after a `levelComplete` fanfare the D-major resolution score plays
 *
 * update(frame) must be called every rendered frame while in 'game' (a watchdog fades the vehicle
 * layers if frames stop). handleEvent / ui / update never throw: failures are logged once and swallowed
 * so audio can never break the game loop or the event fan-out.
 */
import type { GameEvent, RenderFrame } from '@/game/types';
import { SoundCore, type CoreDebug } from './core/SoundCore';
import { clearBufferCache } from './dsp/buffers';
import { DEFAULT_MIX, type AudioMix, type AudioScene, type UiSound } from './types';

export type { AudioMix, AudioScene, UiSound } from './types';
export { DEFAULT_MIX } from './types';

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** HTML UserActivation API (Chrome 72+, Firefox 120+, Safari 16.4+); null where unsupported. */
function userActivation(): UserActivation | null {
  if (typeof navigator === 'undefined') return null;
  return (navigator as { userActivation?: UserActivation }).userActivation ?? null;
}

/** Wall clock (ms) — the context clock does not advance while suspended. */
const wallMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Events that can carry user activation. Per the HTML spec a touch `pointerdown` does NOT (only
 * `pointerup` / `touchend` / `click` do), so listening to `pointerdown` alone never unlocks on touch screens.
 */
const GESTURE_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'] as const;

/**
 * How long after a resume request one-shots may still be scheduled while the context is not yet
 * 'running' (it starts a few ms after a gesture-initiated resume). Bounded so sounds never pile up in a
 * context the browser refused to start.
 */
const RESUME_GRACE_MS = 500;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private core: SoundCore | null = null;
  /** wallMs() of the last ctx.resume() request (-Infinity: none). */
  private resumeRequestedAt = -Infinity;
  /** Removes the one-shot gesture listeners armed by an unlock() made before any user activation. */
  private disarmGesture: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private muteTimer: ReturnType<typeof setTimeout> | null = null;
  private mix: AudioMix = { ...DEFAULT_MIX };
  private scene: AudioScene = 'title';

  /** True once unlock() has created the context (it may still be suspended). */
  get unlocked(): boolean {
    return this.core !== null;
  }

  /** 'locked' before unlock(), otherwise the AudioContext state. */
  get state(): AudioContextState | 'locked' {
    return this.ctx ? this.ctx.state : 'locked';
  }

  /** Current context time (0 before unlock). */
  get currentTime(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /**
   * Create (first call) and resume the AudioContext. Call from a user-gesture handler; idempotent and
   * safe to call on every gesture (it also recovers contexts the browser suspended or interrupted).
   *
   * Called before the page has had any user activation (e.g. from a touch `pointerdown`, which is not
   * an activation), creation is deferred to the next activating gesture (`pointerup` / `touchend` /
   * `click` / `keydown`): a context created without activation would only start suspended. In that
   * case the returned promise resolves immediately.
   */
  unlock(): Promise<void> {
    if (!this.ctx) {
      const Ctor = audioContextCtor();
      if (!Ctor) return Promise.resolve();
      const ua = userActivation();
      if (ua && !ua.hasBeenActive) {
        this.armGestureUnlock();
        return Promise.resolve();
      }
      this.disarmGestureUnlock();
      try {
        this.ctx = new Ctor({ latencyHint: 'interactive' });
      } catch {
        this.ctx = null;
        return Promise.resolve();
      }
      this.core = new SoundCore(this.ctx, { mix: this.mix, scene: this.scene });
      this.core.output.connect(this.ctx.destination);
      this.timer = setInterval(this.onTick, 40);
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
    }
    if (this.mix.muted) {
      // Integrations call unlock() on every gesture: arm the post-fade suspend once rather than pushing a
      // pending one back on every key press (a fresh context may still be starting up, so always arm).
      if (this.muteTimer === null) this.applyRunState();
      return Promise.resolve();
    }
    return this.resume();
  }

  /**
   * Mix levels (perceptual 0..1, squared internally) + mute. Stored before unlock and applied on it.
   * Muting fades out, then suspends the AudioContext entirely (zero audio CPU while muted).
   */
  setMix(mix: AudioMix): void {
    const wasMuted = this.mix.muted;
    this.mix = { master: mix.master, music: mix.music, sfx: mix.sfx, muted: mix.muted };
    this.core?.setMix(this.mix);
    if (wasMuted !== this.mix.muted) this.applyRunState();
  }

  /** Music arrangement / ducking / vehicle-layer gating. Stored before unlock and applied on it. */
  setScene(scene: AudioScene): void {
    this.scene = scene;
    this.core?.setScene(scene);
  }

  /** Per rendered frame: continuous vehicle layers + score intensity. Bound — pass it around freely. */
  readonly update = (frame: RenderFrame): void => {
    if (!this.core || this.ctx?.state !== 'running') return;
    try {
      this.core.update(frame);
    } catch (err) {
      this.report('update', err);
    }
  };

  /**
   * Game event → one-shot. Bound, so `runtime.events.onAny(audio.handleEvent)` works. Never throws:
   * an audio problem must not break the event fan-out (the runner emits from its frame loop).
   */
  readonly handleEvent = (e: GameEvent): void => {
    if (!this.core || !this.canPlay()) return;
    try {
      this.core.handleEvent(e);
    } catch (err) {
      this.report(`event ${e.type}`, err);
    }
  };

  /**
   * Interface sound. Every kind but 'hover' comes from a click / key handler — a user activation — so
   * it also resumes a context the browser left suspended (robust to unlock wiring that missed a gesture).
   */
  ui(kind: UiSound): void {
    if (!this.core) return;
    if (kind !== 'hover' && this.ctx && this.ctx.state !== 'running') void this.resume();
    if (!this.canPlay()) return;
    try {
      this.core.ui(kind);
    } catch (err) {
      this.report(`ui ${kind}`, err);
    }
  }

  /**
   * Convenience: resume audio on every user gesture on `target` (default window). Returns a remover.
   * Useful because some browsers (iOS Safari) re-suspend contexts after interruptions.
   */
  attachAutoUnlock(target?: EventTarget): () => void {
    const t = target ?? (typeof window !== 'undefined' ? window : null);
    if (!t) return () => undefined;
    const handler = (): void => {
      void this.unlock();
    };
    for (const ev of GESTURE_EVENTS) t.addEventListener(ev, handler, { capture: true, passive: true });
    return () => {
      for (const ev of GESTURE_EVENTS) t.removeEventListener(ev, handler, { capture: true });
    };
  }

  /** Analyser on the master output (dev tools / meters). Null before unlock. */
  createAnalyser(fftSize = 2048): AnalyserNode | null {
    return this.core?.createAnalyser(fftSize) ?? null;
  }

  /** Internal state snapshot for dev pages (allocates — not for per-frame use in production). */
  get debug(): CoreDebug | null {
    return this.core?.debug ?? null;
  }

  /** Tear everything down (stops sources, closes the context, drops cached buffers). unlock() can start again. */
  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.muteTimer !== null) clearTimeout(this.muteTimer);
    this.muteTimer = null;
    this.disarmGestureUnlock();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    this.core?.dispose();
    this.core = null;
    const ctx = this.ctx;
    this.ctx = null;
    this.resumeRequestedAt = -Infinity;
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined);
    clearBufferCache();
  }

  /* ---------------------------------------------------------------- */

  /** Muted → suspend after the master fade; unmuted → resume (if visible). */
  private applyRunState(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') return;
    if (this.muteTimer !== null) clearTimeout(this.muteTimer);
    this.muteTimer = null;
    if (this.mix.muted) {
      this.muteTimer = setTimeout(() => {
        this.muteTimer = null;
        if (this.mix.muted && this.ctx === ctx && ctx.state === 'running') void ctx.suspend().catch(() => undefined);
      }, 300);
    } else {
      void this.resume();
    }
  }

  /**
   * Ask the context to run. Deliberately NOT de-duplicated against an earlier pending request: a
   * resume() made without user activation stays pending forever (Chrome neither resolves nor rejects
   * it), and only a fresh call made after a gesture starts the context — which also settles the older
   * promises. Extra calls on a starting context are harmless.
   */
  private resume(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return Promise.resolve();
    if (this.mix.muted) return Promise.resolve();
    if (typeof document !== 'undefined' && document.hidden) return Promise.resolve();
    this.resumeRequestedAt = wallMs();
    return ctx.resume().catch(() => undefined);
  }

  /**
   * One-shots are dropped while the context is not running (they would pile up and fire together on
   * resume) — except right after a resume request made with user activation (the context starts a few
   * ms later), so the very first click still sounds.
   */
  private canPlay(): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    if (typeof document !== 'undefined' && document.hidden) return false;
    if (ctx.state === 'running') return true;
    if (ctx.state !== 'suspended' || this.mix.muted || wallMs() - this.resumeRequestedAt > RESUME_GRACE_MS) return false;
    const ua = userActivation();
    return ua ? ua.isActive : true;
  }

  /** unlock() before any activation: retry on the first gesture that can carry it (once). */
  private armGestureUnlock(): void {
    if (this.disarmGesture || typeof window === 'undefined') return;
    const handler = (): void => {
      const ua = userActivation();
      if (ua && !ua.hasBeenActive) return; // e.g. a touch pointerdown — wait for its pointerup / click
      void this.unlock(); // disarms
    };
    for (const ev of GESTURE_EVENTS) window.addEventListener(ev, handler, { capture: true, passive: true });
    this.disarmGesture = () => {
      for (const ev of GESTURE_EVENTS) window.removeEventListener(ev, handler, { capture: true });
    };
  }

  private disarmGestureUnlock(): void {
    this.disarmGesture?.();
    this.disarmGesture = null;
  }

  private readonly reported = new Set<string>();

  /** Log each distinct audio failure once (visible in dev, never fatal for the game). */
  private report(where: string, err: unknown): void {
    const msg = `${where}: ${err instanceof Error ? err.message : String(err)}`;
    if (this.reported.has(msg)) return;
    this.reported.add(msg);
    console.error(`[audio] ${msg}`);
  }

  private readonly onTick = (): void => {
    if (!this.core || this.ctx?.state !== 'running') return;
    try {
      this.core.tick();
    } catch (err) {
      this.report('tick', err);
    }
  };

  private readonly onVisibility = (): void => {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') return;
    if (document.hidden) void ctx.suspend().catch(() => undefined);
    else void this.resume();
  };
}

/** The game's audio engine singleton. */
export const audio = new AudioEngine();

// Vite HMR: never leave an orphaned AudioContext playing when this module is replaced.
if (import.meta.hot) {
  import.meta.hot.dispose(() => audio.dispose());
}
