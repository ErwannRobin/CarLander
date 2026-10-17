import { Vector3 } from 'three';
import type { Vehicle } from '../physics/Vehicle';
import { clamp, DEG } from '../physics/util';
import { TUNING } from '../tuning';
import type { CrashReason, GameEvent } from '../types';
import { VEHICLE } from '../vehicleSpec';

export interface CrashVerdict {
  reason: CrashReason;
  /** Impact speed reported with the crash event (m/s). */
  impactSpeed: number;
  position: Vector3;
}

export interface CrashCheckInput {
  vehicle: Vehicle;
  killY: number;
  dt: number;
  /**
   * True inside a jump's touchdown/settle window. Wheels-first impacts there are judged by the
   * landing evaluator (impact > HARD threshold ⇒ 'hard-impact'), not by the Δv rule.
   */
  landing: boolean;
  /** True while flying or touching down after a jump (nose-dives only happen out of the air). */
  inJump: boolean;
}

const _n = new Vector3();
const _vt = new Vector3();

/** How long a contact approach speed is remembered for the roof / rollover verdicts (s). */
const PEAK_HOLD = 0.3;
/** Minimum spacing of scrape `impact` events while sliding in contact (s). */
const SCRAPE_INTERVAL = 0.1;
/** Gravity + suction pressing the car into its wheels' surface above this (in g) ⇒ standing on its wheels. */
const SUPPORT_PRESS_G = 0.3;

/**
 * Crash rules (ARCHITECTURE §5), all relative to the touched surface normal — never world up — so
 * driving inverted on the vacuum track is fine:
 *  - fell:      below level.killY
 *  - roof:      roof contact with a surface facing the roof
 *  - nose-dive: out of a jump, the nose points into the surface (> 30°) and hits faster than 15 m/s
 *  - impact:    single-tick contact Δv > 16 m/s (landing-like impacts excluded, see `landing`)
 *  - rollover:  chassis contact with angle(up, n) > 70° held for 0.25 s while the car is NOT standing
 *               on its wheels — an upright car grinding along a wall is not a rollover (see below)
 * Also emits `impact` events (chassis hits/scrapes) for VFX/audio — the sim calls it every tick, also
 * after a crash (the wreck keeps throwing sparks) and only acts on verdicts while running.
 *
 * Reported impact speeds use the approach speed measured on speculative contacts too: Rapier stops
 * the body one tick before the real touch, so the touching tick alone would read ≈ 0 m/s.
 */
export class CrashDetector {
  private rolloverTimer = 0;
  private inContact = false;
  private scrapeTimer = 0;
  /** Contact Δv accumulated over the current scrape window (load estimate for the event strength). */
  private scrapeDv = 0;
  private scrapeTicks = 0;
  /** Highest contact approach speed seen within the last PEAK_HOLD seconds. */
  private peakApproach = 0;
  private peakAge = 0;

  reset(): void {
    this.rolloverTimer = 0;
    this.inContact = false;
    this.scrapeTimer = 0;
    this.scrapeDv = 0;
    this.scrapeTicks = 0;
    this.peakApproach = 0;
    this.peakAge = 0;
  }

  /** Returns a verdict when a crash condition triggers this tick (does not latch). */
  update(input: CrashCheckInput, events: GameEvent[]): CrashVerdict | null {
    const { vehicle, killY, dt } = input;
    const st = vehicle.state;
    const c = TUNING.crash;
    const pre = vehicle.preVelocity;

    // ---- fell ---------------------------------------------------------
    if (st.position.y < killY) return { reason: 'fell', impactSpeed: st.speed, position: st.position.clone() };

    const count = vehicle.contactCount;
    let verdict: CrashVerdict | null = null;
    let maxApproach = 0;
    let tilted = false;
    let touching = 0;
    _n.set(0, 0, 0);
    // approach speed is measured on speculative contacts too: they stop the body before it touches
    for (let i = 0; i < count; i++) {
      const approachSpeed = Math.max(0, -pre.dot(vehicle.contacts[i].normal));
      if (approachSpeed > maxApproach) maxApproach = approachSpeed;
    }
    if (maxApproach >= this.peakApproach || this.peakAge > PEAK_HOLD) {
      this.peakApproach = maxApproach;
      this.peakAge = 0;
    } else {
      this.peakAge += dt;
    }
    const recentImpact = this.peakApproach;
    for (let i = 0; i < count; i++) {
      const k = vehicle.contacts[i];
      const approachSpeed = Math.max(0, -pre.dot(k.normal));
      _n.add(k.normal);
      const upDot = st.up.dot(k.normal);
      // nose-dive: out of the air, nose pointing into the surface, nose contact, fast along the normal
      if (!verdict && input.inJump && k.local.z < -1.4 && st.forward.dot(k.normal) < -0.5 && approachSpeed > c.noseDiveSpeed) {
        verdict = { reason: 'nose-dive', impactSpeed: approachSpeed, position: k.point.clone() };
      }
      if (!k.touching) continue;
      touching++;
      // roof: upper body touching a surface that faces the roof
      if (!verdict && upDot < -0.5 && k.local.y > 0.3) {
        verdict = { reason: 'roof', impactSpeed: Math.max(approachSpeed, recentImpact), position: k.point.clone() };
      }
      if (Math.acos(clamp(upDot, -1, 1)) > c.rolloverAngleDeg * DEG) tilted = true;
    }
    // Standing on its wheels, a steep chassis contact is a wall / rail scrape, not a rollover. "Standing"
    // = ≥ 2 wheels on a surface that gravity + vacuum suction actually press the car into (so the vacuum
    // ceiling counts, while a car lying on its side with its wheels merely touching a wall does not).
    if (tilted && st.groundedWheels >= 2) {
      const gn = vehicle.groundNormal;
      const press = TUNING.gravity * gn.y - vehicle.vacuum.force.dot(gn) / VEHICLE.mass;
      if (press > SUPPORT_PRESS_G * TUNING.gravity) tilted = false;
    }

    // ---- impact events (sparks / scrape audio) ------------------------------
    if (count > 0) {
      const k = vehicle.contacts[0];
      if (!this.inContact) {
        if (maxApproach > 1 || touching > 0) {
          events.push({ type: 'impact', position: k.point.clone(), normal: k.normal.clone(), strength: clamp(maxApproach / 18, 0.05, 1) });
        }
        this.scrapeTimer = SCRAPE_INTERVAL;
        this.scrapeDv = 0;
        this.scrapeTicks = 0;
      } else if (touching > 0) {
        this.scrapeTimer -= dt;
        this.scrapeDv += vehicle.contactDeltaV;
        this.scrapeTicks++;
        _vt.copy(st.velocity).addScaledVector(k.normal, -st.velocity.dot(k.normal));
        const slide = _vt.length();
        if (this.scrapeTimer <= 0 && slide > 3) {
          // Strength = sliding speed × how hard the body is pressed: the mean contact Δv per tick over the
          // window, in units of g·dt, approximates the contact load in g (a car sliding on its roof ≈ 1).
          // A light graze at speed (nose kissing a concave ramp) therefore stays faint.
          const load = this.scrapeDv / Math.max(1, this.scrapeTicks) / (TUNING.gravity * dt);
          const strength = clamp(slide / 40, 0.05, 0.6) * clamp(load, 0.15, 1);
          events.push({ type: 'impact', position: k.point.clone(), normal: k.normal.clone(), strength: Math.max(0.05, strength) });
          this.scrapeTimer = SCRAPE_INTERVAL;
          this.scrapeDv = 0;
          this.scrapeTicks = 0;
        }
      }
    }
    this.inContact = count > 0;
    if (verdict) return verdict;

    // ---- high-energy impact ----------------------------------------------------
    if (count > 0 && vehicle.contactDeltaV > c.impactDeltaV) {
      _n.normalize();
      const landingLike = input.landing && st.up.dot(_n) > Math.cos(TUNING.landing.hard.angleDeg * DEG);
      if (!landingLike) {
        return {
          reason: 'impact',
          impactSpeed: Math.max(vehicle.contactDeltaV, maxApproach),
          position: vehicle.contacts[0].point.clone(),
        };
      }
    }

    // ---- rollover ------------------------------------------------------------------
    if (tilted) {
      this.rolloverTimer += dt;
      if (this.rolloverTimer >= c.rolloverTime) {
        return { reason: 'rollover', impactSpeed: Math.max(maxApproach, recentImpact), position: st.position.clone() };
      }
    } else {
      this.rolloverTimer = 0;
    }
    return null;
  }
}
