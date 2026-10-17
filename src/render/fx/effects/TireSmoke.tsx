/**
 * TireSmoke — soft, expanding, drifting smoke from slipping tires, plus the big dense white
 * billows of hard landings and of thrusting close to the ground.
 *
 *  - Per grounded wheel with slip > 0.25: emission at the contact patch, rate ~ slip * speed
 *    (with a floor so standing burnouts still smoke), interpolated along the contact path.
 *  - Touchdown: a tire "chirp" puff cluster at every wheel (scaled by landing quality / impact),
 *    followed by a very short skid stream so it also reads at speed.
 *  - Hard / crash landings (or a high impact speed): a ring of dense, ground-hugging billows
 *    around the car footprint that rolls outwards and rises slowly.
 *  - Thrust near the ground (grounded or < 3.5 m): when the exhaust is aimed into the surface the
 *    blast raises dramatic billows behind the car; when it merely skims the ground (normal driving
 *    boost) only a faint, low dust wisp is kicked up.
 * The smoke pool's focus fade keeps the car readable through the densest clouds.
 */
import { useEffect } from 'react';
import { Vector3 } from 'three';
import { runtime } from '@/game/runtime';
import type { LandingResult, SimSnapshot } from '@/game/types';
import { NOZZLES, VEHICLE, WHEEL_POSITIONS } from '@/game/vehicleSpec';
import type { FXFrameContext } from '../core/FXSystem';
import {
  clamp01,
  linearRGB,
  projectOnPlaneSafe,
  rand,
  randSigned,
  RateAccumulator,
  smoothstep,
  tangentBasis,
  viewAlignment,
} from '../core/math';
import { ParticleSpawn, randomSmokeSprite } from '../core/ParticlePool';
import { useFX, useFXFrame, useFXReset } from '../FXContext';
import { useConst } from '../core/useConst';

const SLIP_THRESHOLD = 0.25;
/** Max distance between consecutive slip-smoke puffs of one wheel at speed (m). */
const SMOKE_SPACING = 0.32;
/** Duration of the post-touchdown skid stream (s). */
const BURST_TIME = 0.25;
const NEAR_GROUND = 3.5;
const RIDE = -VEHICLE.groundY;
const C_TIRE = linearRGB('#eeebe6');
const C_BILLOW = linearRGB('#f6f5f2');
const C_DUST = linearRGB('#e6e1d8');

const WORLD_UP = new Vector3(0, 1, 0);
const _p = new Vector3();
const _n = new Vector3();
const _t = new Vector3();
const _b = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _exhaust = new Vector3();
const _rear = new Vector3();
const _radial = new Vector3();
const _ground = new Vector3();
const _vel = new Vector3();
const _spawn = new ParticleSpawn();

/** Tracks the latest known ground plane under the car. */
class GroundTracker {
  readonly point = new Vector3();
  readonly normal = new Vector3(0, 1, 0);
  valid = false;

  update(snapshot: SimSnapshot, position: Vector3): void {
    const v = snapshot.vehicle;
    if (v.groundedWheels > 0) {
      this.point.set(0, 0, 0);
      _n.set(0, 0, 0);
      let k = 0;
      for (let i = 0; i < v.wheels.length; i++) {
        const w = v.wheels[i];
        if (!w.grounded) continue;
        this.point.add(w.contactPoint);
        _n.add(w.contactNormal);
        k++;
      }
      if (k > 0) {
        this.point.multiplyScalar(1 / k);
        if (_n.lengthSq() > 1e-6) this.normal.copy(_n.normalize());
        this.valid = true;
      }
    } else if (Number.isFinite(snapshot.air.height) && snapshot.air.height < 40) {
      // airborne: surface directly below (world down)
      this.normal.copy(WORLD_UP);
      this.point.copy(position).addScaledVector(WORLD_UP, -(snapshot.air.height + RIDE));
      this.valid = true;
    } else {
      this.valid = false;
    }
  }

  reset(): void {
    this.valid = false;
    this.normal.copy(WORLD_UP);
  }
}

/** Landing intensity 0..1 from quality and impact speed. */
function landingStrength(r: LandingResult): number {
  const base = r.quality === 'crash' ? 1 : r.quality === 'hard' ? 0.8 : r.quality === 'clean' ? 0.45 : 0.25;
  return clamp01(base + (r.impactSpeed - 10) / 30);
}

export function TireSmoke() {
  const fx = useFX();
  const st = useConst(() => ({
    prev: [new Vector3(), new Vector3(), new Vector3(), new Vector3()],
    hadContact: [false, false, false, false],
    acc: [new RateAccumulator(), new RateAccumulator(), new RateAccumulator(), new RateAccumulator()],
    billow: new RateAccumulator(),
    skim: new RateAccumulator(),
    ground: new GroundTracker(),
    pendingLanding: null as LandingResult | null,
    /** Post-touchdown skid stream: intensity 0..1 and remaining time (s). */
    burst: 0,
    burstT: 0,
  }));

  useEffect(
    () =>
      runtime.events.on('landing', (e) => {
        st.pendingLanding = e.result;
        st.burst = Math.max(st.burst, landingStrength(e.result));
        st.burstT = BURST_TIME;
      }),
    [st],
  );

  useFXReset(() => {
    st.hadContact.fill(false);
    st.pendingLanding = null;
    st.burst = 0;
    st.burstT = 0;
    st.ground.reset();
    for (let i = 0; i < st.acc.length; i++) st.acc[i].reset();
    st.billow.reset();
    st.skim.reset();
  });

  useFXFrame((ctx: FXFrameContext) => {
    const { snapshot, frame, dt } = ctx;
    const v = snapshot.vehicle;
    st.ground.update(snapshot, frame.position);
    if (dt <= 0) return;
    const q = ctx.quality;
    const speed = v.speed;

    // --- per-wheel slip smoke (+ the short touchdown skid stream) ---
    let burstSlip = 0;
    if (st.burstT > 0) {
      st.burstT = Math.max(0, st.burstT - dt);
      const e = st.burstT / BURST_TIME;
      burstSlip = SLIP_THRESHOLD + (1 - SLIP_THRESHOLD) * st.burst * e * e;
      if (st.burstT === 0) st.burst = 0;
    }
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i];
      const prev = st.prev[i];
      if (!w.grounded || v.crashed) {
        st.hadContact[i] = false;
        continue;
      }
      if (!st.hadContact[i] || prev.distanceToSquared(w.contactPoint) > 25) prev.copy(w.contactPoint);
      st.hadContact[i] = true;
      const wheelSlip = Math.max(w.slip, burstSlip);
      if (wheelSlip > SLIP_THRESHOLD) {
        const slip = clamp01((wheelSlip - SLIP_THRESHOLD) / (1 - SLIP_THRESHOLD));
        // smoke "mass" emitted per second ~ slip * speed; at speed the puffs are spread along the
        // contact path at least every SMOKE_SPACING m (so young puffs overlap into a streak rather
        // than a string of beads), with the opacity carrying the slip-dependent density
        const massRate = 3.2 * wheelSlip * Math.max(speed, 12);
        const rate = Math.max(massRate, speed / SMOKE_SPACING);
        const density = massRate / rate;
        const count = st.acc[i].take(rate * q, dt, 10);
        tangentBasis(w.contactNormal, _t, _b);
        for (let k = 0; k < count; k++) {
          const f = (k + Math.random()) / count;
          _p.lerpVectors(prev, w.contactPoint, f).addScaledVector(w.contactNormal, 0.2);
          const s = _spawn.reset();
          s.setPosition(_p);
          s.offset(_t, randSigned() * 0.15).offset(_b, randSigned() * 0.15);
          // drift in the contact plane (correct on walls / the inverted vacuum section too)
          s.setVelocity(v.velocity, 0.3).addVelocity(w.contactNormal, rand(0.5, 1.4));
          s.addVelocity(_t, randSigned() * 1.1).addVelocity(_b, randSigned() * 1.1);
          s.age = (1 - f) * dt;
          s.life = rand(2.2, 3.6) * (0.8 + 0.4 * slip);
          s.size0 = rand(0.55, 0.75);
          s.size1 = rand(3.0, 4.4) * (0.75 + 0.45 * slip);
          s.sizeEase = 2.3;
          s.color0(C_TIRE, (0.24 + 0.2 * slip) * (1.25 - 0.25 * q) * density).color1(C_TIRE, 0);
          s.fadeIn = 0.06;
          s.fadeOut = 0.72;
          s.rot = Math.random() * Math.PI * 2;
          s.rotSpeed = randSigned() * 0.5;
          s.drag = 1.4;
          s.gravity = -0.035;
          s.softPlane(w.contactNormal, w.contactPoint, 0.8);
          s.blob = 0.85;
          s.sprite = randomSmokeSprite();
          fx.smoke.spawn(s);
        }
      }
      prev.copy(w.contactPoint);
    }

    // --- touchdown: chirp puffs at the wheels + billows for hard landings ---
    if (st.pendingLanding) {
      const r = st.pendingLanding;
      st.pendingLanding = null;
      if (!v.crashed) touchdownChirp(ctx, landingStrength(r));
      if (r.quality === 'hard' || r.quality === 'crash' || r.impactSpeed > 14) landingBillows(ctx, r, st.ground);
    }

    // --- thrust near the ground ---
    const g = st.ground;
    const height = v.groundedWheels > 0 ? 0 : snapshot.air.height;
    if (v.boostLevel > 0.05 && g.valid && height < NEAR_GROUND && !v.crashed) {
      _exhaust.set(0, 0, 1).applyQuaternion(frame.quaternion);
      const proximity = 1 - height / NEAR_GROUND;
      const aim = Math.max(0, -_exhaust.dot(g.normal)); // 1 = blasting straight into the surface
      const billowWeight = proximity * v.boostLevel * smoothstep(0.12, 0.65, aim);
      const skimWeight = proximity * v.boostLevel * (1 - smoothstep(0.1, 0.5, aim));
      if (billowWeight > 0.01) thrustBillows(ctx, g, billowWeight);
      if (skimWeight > 0.01) thrustSkim(ctx, g, skimWeight);
    }
  });

  /** Brief puff cluster at every wheel contact (tires spinning up at touchdown). */
  function touchdownChirp(ctx: FXFrameContext, k: number) {
    const v = ctx.snapshot.vehicle;
    const n = st.ground.valid ? st.ground.normal : WORLD_UP;
    tangentBasis(n, _t, _b);
    // tangential part of the car velocity (smoke is dragged along a little)
    _vel.copy(v.velocity).addScaledVector(n, -v.velocity.dot(n));
    const per = Math.max(1, Math.round((1 + 10 * k) * Math.max(0.5, ctx.quality)));
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i];
      if (w.grounded) _p.copy(w.contactPoint);
      else {
        const [x, , z] = WHEEL_POSITIONS[i];
        _p.set(x, -RIDE, z).applyQuaternion(ctx.frame.quaternion).add(ctx.frame.position);
      }
      _p.addScaledVector(n, 0.25);
      for (let j = 0; j < per; j++) {
        const s = _spawn.reset();
        s.setPosition(_p).offset(_t, randSigned() * 0.25).offset(_b, randSigned() * 0.25);
        s.setVelocity(_vel, 0.35).addVelocity(_t, randSigned() * 2.2).addVelocity(_b, randSigned() * 2.2);
        s.addVelocity(n, rand(0.3, 1.0));
        s.life = rand(1.2, 2.2) * (0.7 + 0.5 * k);
        s.size0 = rand(0.35, 0.55);
        s.size1 = rand(1.4, 2.4) * (0.7 + 0.5 * k);
        s.sizeEase = 2.4;
        s.color0(C_TIRE, 0.12 + 0.36 * k).color1(C_TIRE, 0);
        s.fadeIn = 0.04;
        s.fadeOut = 0.7;
        s.rot = Math.random() * Math.PI * 2;
        s.rotSpeed = randSigned() * 0.6;
        s.drag = 2.4;
        s.gravity = -0.03;
        s.softPlane(n, _p, 0.35);
        s.blob = 1;
        s.sprite = randomSmokeSprite();
        fx.smoke.spawn(s);
      }
    }
  }

  /** Ring of dense, ground-hugging billows around the car footprint (hard landings, crashes). */
  function landingBillows(ctx: FXFrameContext, r: LandingResult, ground: GroundTracker) {
    const v = ctx.snapshot.vehicle;
    const k = clamp01((r.impactSpeed - 8) / 16) * 0.6 + (r.quality === 'crash' ? 0.4 : r.quality === 'hard' ? 0.25 : 0);
    const n = ground.valid ? ground.normal : WORLD_UP;
    if (ground.valid) _ground.copy(ground.point);
    else _ground.copy(r.position).addScaledVector(WORLD_UP, -RIDE);
    projectOnPlaneSafe(_fwd.set(0, 0, -1).applyQuaternion(ctx.frame.quaternion), n);
    _right.crossVectors(_fwd, n).normalize();
    _vel.copy(v.velocity).addScaledVector(n, -v.velocity.dot(n));
    const count = Math.round((32 + 40 * k) * Math.max(0.5, ctx.quality));
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const rr = 0.55 + 0.6 * Math.random();
      _radial.copy(_fwd).multiplyScalar(Math.cos(a) * 2.4 * rr).addScaledVector(_right, Math.sin(a) * 1.4 * rr);
      const s = _spawn.reset();
      s.setPosition(_ground).offset(_radial).offset(n, rand(0.2, 0.9));
      _radial.normalize();
      s.setVelocity(_vel, 0.28).addVelocity(_radial, rand(1.8, 5.5) * (0.7 + 0.5 * k)).addVelocity(n, rand(0.4, 1.7));
      s.life = rand(2.2, 3.8);
      s.size0 = rand(0.8, 1.3);
      s.size1 = rand(2.6, 4.6) * (0.85 + 0.3 * k);
      s.sizeEase = 2.3;
      s.color0(C_BILLOW, 0.55).color1(C_BILLOW, 0);
      s.fadeIn = 0.03;
      s.fadeOut = 0.62;
      s.rot = Math.random() * Math.PI * 2;
      s.rotSpeed = randSigned() * 0.3;
      s.drag = 1.6;
      s.gravity = -0.03;
      s.softPlane(n, _ground, 0.45);
      s.blob = 0.6;
      s.sprite = randomSmokeSprite();
      fx.smoke.spawn(s);
    }
  }

  /** Exhaust blasting into the surface: dense billows rolling out behind / under the car. */
  function thrustBillows(ctx: FXFrameContext, g: GroundTracker, weight: number) {
    const { frame, dt } = ctx;
    const v = ctx.snapshot.vehicle;
    const count = st.billow.take(52 * weight * ctx.quality, dt, 10);
    if (count === 0) return;
    const nozzleZ = NOZZLES[0]?.position[2] ?? 2.2;
    tangentBasis(g.normal, _t, _b);
    for (let k = 0; k < count; k++) {
      _rear.set(randSigned() * 0.4, 0, nozzleZ).applyQuaternion(frame.quaternion).add(frame.position);
      // where the blast hits the surface: along the exhaust axis, clamped to the ground plane
      _p.copy(_rear).addScaledVector(_exhaust, rand(0.6, 3.2));
      const h = (_p.x - g.point.x) * g.normal.x + (_p.y - g.point.y) * g.normal.y + (_p.z - g.point.z) * g.normal.z;
      _p.addScaledVector(g.normal, 0.35 - h);
      const s = _spawn.reset();
      s.setPosition(_p);
      s.setVelocity(v.velocity, 0.2).addVelocity(_exhaust, rand(4, 9));
      // flatten the blast along the surface, then add lift and lateral spread
      const vn = s.vx * g.normal.x + s.vy * g.normal.y + s.vz * g.normal.z;
      s.vx -= g.normal.x * vn;
      s.vy -= g.normal.y * vn;
      s.vz -= g.normal.z * vn;
      s.addVelocity(g.normal, rand(0.8, 2.4)).addVelocity(_t, randSigned() * 3.2).addVelocity(_b, randSigned() * 3.2);
      s.age = Math.random() * dt;
      s.life = rand(2.0, 3.2);
      s.size0 = rand(0.8, 1.2);
      s.size1 = rand(3.2, 5.2);
      s.sizeEase = 2.2;
      s.color0(C_BILLOW, 0.4 + 0.2 * weight).color1(C_BILLOW, 0);
      s.fadeIn = 0.06;
      s.fadeOut = 0.62;
      s.rot = Math.random() * Math.PI * 2;
      s.rotSpeed = randSigned() * 0.35;
      s.drag = 1.7;
      s.gravity = -0.03;
      s.softPlane(g.normal, g.point, 0.5);
      s.blob = 0.6;
      s.sprite = randomSmokeSprite();
      fx.smoke.spawn(s);
    }
  }

  /** Exhaust skimming the surface (boost while driving): a faint, low dust wisp behind the car. */
  function thrustSkim(ctx: FXFrameContext, g: GroundTracker, weight: number) {
    const { frame, dt } = ctx;
    const v = ctx.snapshot.vehicle;
    // distance-based: one faint wisp every ~0.45 m of travel, so they merge into a continuous low
    // haze instead of reading as separate blobs at speed
    const rate = Math.max(12, v.speed / 0.45) * weight * Math.max(0.5, ctx.quality);
    const count = st.skim.take(rate, dt, 10);
    if (count === 0) return;
    const nozzleZ = NOZZLES[0]?.position[2] ?? 2.2;
    tangentBasis(g.normal, _t, _b);
    // seen along the haze (chase camera at speed) the wisps pile up into a lumpy column: thin it
    _rear.set(0, 0, nozzleZ).applyQuaternion(frame.quaternion).add(frame.position);
    const view = 1 - 0.8 * smoothstep(0.7, 0.97, viewAlignment(ctx.camera, _rear, _exhaust));
    for (let k = 0; k < count; k++) {
      _rear.set(randSigned() * 0.5, 0, nozzleZ).applyQuaternion(frame.quaternion).add(frame.position);
      _p.copy(_rear).addScaledVector(_exhaust, rand(2.0, 4.0));
      const h = (_p.x - g.point.x) * g.normal.x + (_p.y - g.point.y) * g.normal.y + (_p.z - g.point.z) * g.normal.z;
      _p.addScaledVector(g.normal, 0.25 - h);
      const s = _spawn.reset();
      s.setPosition(_p);
      s.setVelocity(v.velocity, 0.1).addVelocity(_exhaust, rand(3, 6));
      const vn = s.vx * g.normal.x + s.vy * g.normal.y + s.vz * g.normal.z;
      s.vx -= g.normal.x * vn;
      s.vy -= g.normal.y * vn;
      s.vz -= g.normal.z * vn;
      s.addVelocity(g.normal, rand(0.2, 0.6)).addVelocity(_t, randSigned() * 1.2).addVelocity(_b, randSigned() * 1.2);
      s.age = Math.random() * dt;
      // ~12 m of haze behind the car whatever the speed (fades before reaching the chase camera)
      s.life = Math.min(0.7, Math.max(0.25, 12 / Math.max(v.speed, 1))) * rand(0.85, 1.15);
      s.size0 = rand(0.6, 0.8);
      s.size1 = rand(1.5, 2.1);
      s.sizeEase = 2.2;
      s.color0(C_DUST, (0.015 + 0.03 * weight) * view).color1(C_DUST, 0);
      s.fadeIn = 0.1;
      s.fadeOut = 0.75;
      s.rot = Math.random() * Math.PI * 2;
      s.rotSpeed = randSigned() * 0.4;
      s.drag = 2.2;
      s.gravity = -0.02;
      s.softPlane(g.normal, g.point, 0.4);
      s.blob = 1;
      s.sprite = randomSmokeSprite();
      fx.smoke.spawn(s);
    }
  }

  return null;
}
