/**
 * Click-free AudioParam helpers.
 *
 * Rule of thumb used throughout the module: long-lived parameters are only ever moved with
 * `setTargetAtTime` (an exponential approach that starts at an instant and never "ends"), so a later
 * `cancelScheduledValues(t)` can never yank a parameter back to a stale value. Short percussive
 * envelopes use a linear attack + exponential decay and are never cancelled.
 */

/**
 * Compute a parameter once per 128-sample render quantum instead of per sample. For slowly moving,
 * smoothed parameters (filter cutoffs, glides, slow LFOs) the 2.7 ms stepping is inaudible, and it avoids
 * per-sample biquad coefficient recomputation (≈3× cheaper filters). Never used on gains or FM inputs.
 */
export function kRate<T extends AudioParam>(param: T): T {
  try {
    param.automationRate = 'k-rate';
  } catch {
    /* engines that do not allow changing it keep a-rate */
  }
  return param;
}

/** Approach `value` from time `t` with time constant `tc` (≈63 % after tc, ≈99 % after 4.6·tc). */
export function glide(param: AudioParam, value: number, t: number, tc: number): void {
  param.setTargetAtTime(value, t, tc > 0.0005 ? tc : 0.0005);
}

/**
 * Percussive envelope: 0 → `peak` linearly over `attack`, then exponential decay reaching -40 dB after
 * `decay` seconds. Returns a safe stop time (≈ -60 dB) for the sources feeding this envelope.
 */
export function percEnv(param: AudioParam, t: number, peak: number, attack: number, decay: number): number {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.setTargetAtTime(0, t + attack, decay / 4.6);
  return t + attack + decay * 1.5 + 0.02;
}

/**
 * Swell envelope (soft attack): exponential rise toward `peak` (≈95 % after `attack`), exponential
 * release starting at `releaseAt` reaching -40 dB after `release`. Returns a safe stop time.
 */
export function swellEnv(
  param: AudioParam,
  t: number,
  peak: number,
  attack: number,
  releaseAt: number,
  release: number,
): number {
  param.setValueAtTime(0, t);
  param.setTargetAtTime(peak, t, attack / 3);
  param.setTargetAtTime(0, Math.max(releaseAt, t + 0.001), release / 4.6);
  return Math.max(releaseAt, t) + release * 1.5 + 0.02;
}

/** Exponential frequency sweep (both ends must be > 0). */
export function sweep(param: AudioParam, from: number, to: number, t: number, duration: number): void {
  param.setValueAtTime(Math.max(1e-3, from), t);
  param.exponentialRampToValueAtTime(Math.max(1e-3, to), t + Math.max(0.001, duration));
}

/**
 * Per-frame parameter driver: forwards targets to an AudioParam with `setTargetAtTime`, skipping
 * changes below a threshold so 60–144 Hz update loops keep the automation timeline short.
 */
export class ParamDriver {
  private last: number;

  /**
   * @param eps minimum change that triggers an automation event (absolute, or relative when `relative`)
   */
  constructor(
    readonly param: AudioParam,
    initial: number,
    private readonly tc: number,
    private readonly eps: number,
    private readonly relative = false,
  ) {
    this.last = initial;
    param.value = initial;
  }

  get target(): number {
    return this.last;
  }

  set(value: number, t: number, tc: number = this.tc): void {
    if (!Number.isFinite(value)) return; // never let a bad sim value throw inside the frame loop
    const last = this.last;
    const threshold = this.relative ? Math.abs(last) * this.eps : this.eps;
    // Always let an exact zero through so silent layers really reach silence.
    if (Math.abs(value - last) <= threshold && !(value === 0 && last !== 0)) return;
    this.last = value;
    this.param.setTargetAtTime(value, t, tc > 0.0005 ? tc : 0.0005);
  }
}
