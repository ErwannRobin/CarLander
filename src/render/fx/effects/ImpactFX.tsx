/**
 * ImpactFX — metal-on-concrete feedback.
 *  - 'impact': hot additive spark streaks thrown along the scrape direction, with gravity and
 *    bounces on the contact plane; a tiny hot flash at the contact.
 *  - 'crash' : a bigger spark burst, a brief orange flash light + flash sprite, dark debris specks
 *    and rolling debris smoke.
 */
import { useEffect } from 'react';
import { Vector3 } from 'three';
import { runtime } from '@/game/runtime';
import type { SimSnapshot } from '@/game/types';
import { VEHICLE } from '@/game/vehicleSpec';
import { PALETTE } from '@/render/palette';
import type { FXFrameContext } from '../core/FXSystem';
import { clamp01, linearRGB, rand, randomInCone, randomUnitVector, randSigned, smoothstep, tangentBasis } from '../core/math';
import { ParticleSpawn, randomSmokeSprite, SPRITE_GLOW } from '../core/ParticlePool';
import { RingSpawn } from '../core/RingWavePool';
import { useFX, useFXFrame, useFXReset } from '../FXContext';
import { useConst } from '../core/useConst';

const C_SPARK_HOT = linearRGB('#fff6e2');
const C_SPARK_COOL = linearRGB('#ff4f0e');
const C_FLASH = linearRGB(PALETTE.orangeHot);
/** Crash dust: a darker sooty core that dilutes into light concrete dust. */
const C_SOOT = linearRGB('#55524f');
const C_DUST = linearRGB('#b9b4ad');
const C_DUST_END = linearRGB('#d6d2cb');
const C_DEBRIS = linearRGB('#1a1a1a');
const C_SHOCK = linearRGB('#f3ede2');

const WORLD_UP = new Vector3(0, 1, 0);
const RIDE = -VEHICLE.groundY;
const _axis = new Vector3();
const _tan = new Vector3();
const _away = new Vector3();
const _dir = new Vector3();
const _t = new Vector3();
const _b = new Vector3();
const _p = new Vector3();
const _contact = new Vector3();
const _spawn = new ParticleSpawn();
const _ring = new RingSpawn();

interface PendingImpact {
  kind: 'impact' | 'crash';
  /** Contact point (impact) or car position (crash). */
  position: Vector3;
  /** Surface point below `position` (collision plane for sparks / debris). */
  ground: Vector3;
  normal: Vector3;
  strength: number;
}

/** Surface point under a crash position (wheel contact, else the height above ground). */
function crashGround(snapshot: SimSnapshot, position: Vector3, out: Vector3): { point: Vector3; normal: Vector3 } {
  const wheels = snapshot.vehicle.wheels;
  for (let i = 0; i < wheels.length; i++) {
    const w = wheels[i];
    if (!w.grounded) continue;
    const d = _p.copy(position).sub(w.contactPoint).dot(w.contactNormal);
    out.copy(position).addScaledVector(w.contactNormal, -d);
    return { point: out, normal: w.contactNormal };
  }
  const h = snapshot.air.height;
  const drop = Number.isFinite(h) && h < 6 ? Math.max(0, h) + RIDE : RIDE;
  out.copy(position).addScaledVector(WORLD_UP, -drop);
  return { point: out, normal: WORLD_UP };
}

export function ImpactFX() {
  const fx = useFX();
  const st = useConst(() => ({ queue: [] as PendingImpact[] }));

  useEffect(() => {
    const offImpact = runtime.events.on('impact', (e) => {
      const normal = e.normal.clone();
      // sparks are sprayed around the contact normal: never trust a degenerate one
      if (!(normal.lengthSq() > 1e-8)) normal.copy(WORLD_UP);
      else normal.normalize();
      st.queue.push({
        kind: 'impact',
        position: e.position.clone(),
        ground: e.position.clone(),
        normal,
        strength: e.strength,
      });
    });
    const offCrash = runtime.events.on('crash', (e) => {
      const g = crashGround(runtime.frame.snapshot, e.position, new Vector3());
      st.queue.push({
        kind: 'crash',
        position: e.position.clone(),
        ground: g.point,
        normal: g.normal.clone(),
        strength: clamp01(e.impactSpeed / 25),
      });
    });
    return () => {
      offImpact();
      offCrash();
    };
  }, [st]);

  useFXReset(() => {
    st.queue.length = 0;
  });

  useFXFrame((ctx: FXFrameContext) => {
    if (st.queue.length === 0 || ctx.dt <= 0) return;
    const queue = st.queue;
    for (let i = 0; i < queue.length; i++) {
      const ev = queue[i];
      if (ev.kind === 'impact') sparks(ctx, ev.position, ev.normal, ev.strength, 1);
      else crash(ctx, ev.position, ev.ground, ev.normal, ev.strength);
    }
    queue.length = 0;
  });

  /**
   * Spark spray. Sparks are torn off against the static surface, so they keep only part of the car
   * velocity: from the chase camera they stream backwards in a tight, low fan that hugs and bounces
   * off the surface (a few heavier sparks arc higher). Also correct for a car at rest (radial burst
   * away from the body).
   */
  function sparks(ctx: FXFrameContext, p: Vector3, n: Vector3, strength: number, mult: number) {
    const v = ctx.snapshot.vehicle;
    _tan.copy(v.velocity).addScaledVector(n, -v.velocity.dot(n));
    const tangential = _tan.length();
    if (tangential > 1e-3) _tan.multiplyScalar(1 / tangential);
    _away.copy(p).sub(v.position);
    _away.addScaledVector(n, -_away.dot(n)); // outward from the body, in the surface plane
    if (_away.lengthSq() > 0.0025) _away.normalize();
    else tangentBasis(n, _away, _b);
    const moving = smoothstep(1, 10, tangential);
    // spray axis: mostly along the surface (backwards when moving, outwards at rest), a bit up
    _axis
      .copy(_away)
      .multiplyScalar(0.9 - 0.55 * moving)
      .addScaledVector(_tan, -1.1 * moving)
      .addScaledVector(n, 0.42)
      .normalize();
    const q = Math.max(0.5, ctx.quality);
    const count = Math.round((22 + 64 * strength) * mult * q);
    for (let i = 0; i < count; i++) {
      const heavy = Math.random() < 0.12;
      randomInCone(_dir, _axis, heavy ? 0.7 : 0.42);
      const s = _spawn.reset();
      s.setPosition(p).offset(n, 0.04);
      s.setVelocity(v.velocity, rand(0.3, 0.65)).addVelocity(_dir, rand(5, 17) * (0.65 + 0.55 * strength));
      if (heavy) s.addVelocity(n, rand(1, 3));
      s.life = heavy ? rand(0.7, 1.2) : rand(0.25, 0.65);
      s.size0 = heavy ? rand(0.06, 0.085) : rand(0.035, 0.055);
      s.size1 = 0.015;
      s.color0(C_SPARK_HOT, 1, heavy ? 7 : 6).color1(C_SPARK_COOL, 0, 2.2);
      s.colorPow = 0.45;
      s.fadeOut = 0.3;
      s.stretch = heavy ? 0.03 : 0.045;
      s.drag = 0.8;
      s.gravity = 1;
      s.collidePlane(n, p, 0.35);
      s.sprite = SPRITE_GLOW;
      fx.glow.spawn(s);
    }
    // tiny hot flash at the contact point
    const s = _spawn.reset();
    s.setPosition(p).offset(n, 0.1);
    s.setVelocity(v.velocity, 0.8);
    s.life = 0.08;
    s.size0 = 0.3 + 0.35 * strength;
    s.size1 = 0.8 + 0.5 * strength;
    s.color0(C_SPARK_HOT, 0.9, 3.5).color1(C_FLASH, 0, 2);
    fx.glow.spawn(s);
  }

  /** Crash burst: `p` = car position (flash), `g` = ground point below it (sparks, decals, debris). */
  function crash(ctx: FXFrameContext, p: Vector3, g: Vector3, n: Vector3, strength: number) {
    const v = ctx.snapshot.vehicle;
    const q = Math.max(0.5, ctx.quality);
    _contact.copy(g).addScaledVector(n, 0.12);
    sparks(ctx, _contact, n, Math.max(0.6, strength), 2.2);
    // flash sprite + light (the light also tints nearby smoke: FX local lights)
    let s = _spawn.reset();
    s.setPosition(p).offset(n, 0.5);
    s.setVelocity(v.velocity, 0.5);
    s.life = 0.18;
    s.size0 = 2.2;
    s.size1 = 4.2;
    s.sizeEase = 2;
    s.color0(C_FLASH, 0.8, 4).color1(C_SPARK_COOL, 0, 1.5);
    fx.glow.spawn(s);
    _p.copy(p).addScaledVector(n, 1.2);
    fx.flash(_p, C_FLASH, 140, 0.38);
    // ground shock
    const r = _ring.reset();
    r.center.copy(g);
    r.normal.copy(n);
    r.kind = 'shock';
    r.r0 = 1;
    r.r1 = 6.5;
    r.life = 0.36;
    r.thickness = 0.26;
    r.alpha = 0.2;
    r.color = C_SHOCK;
    r.additive = 0.1;
    fx.rings.spawn(r);
    // debris specks (dark, ballistic, bouncing)
    const nd = Math.round(18 * q);
    for (let i = 0; i < nd; i++) {
      randomUnitVector(_dir);
      if (_dir.dot(n) < 0) _dir.addScaledVector(n, -2 * _dir.dot(n));
      s = _spawn.reset();
      s.setPosition(_contact).offset(n, 0.2);
      s.setVelocity(v.velocity, 0.55).addVelocity(_dir, rand(3, 9));
      s.life = rand(0.9, 1.6);
      s.size0 = rand(0.04, 0.08);
      s.size1 = s.size0;
      s.color0(C_DEBRIS, 1).color1(C_DEBRIS, 0);
      s.fadeOut = 0.25;
      s.gravity = 1;
      s.drag = 0.4;
      s.collidePlane(n, g, 0.3);
      s.sprite = SPRITE_GLOW;
      s.rot = Math.random() * 6.28;
      fx.smoke.spawn(s);
    }
    // rolling debris dust: a few sooty puffs at the impact, lighter concrete dust around them. Puffs
    // start as soft blobs (blob morph) and grow into billows, with a wide spread of sizes, so the
    // burst reads as one rolling cloud instead of a cluster of separate cotton balls.
    tangentBasis(n, _t, _b);
    _tan.copy(v.velocity).addScaledVector(n, -v.velocity.dot(n));
    const ns = Math.round(34 * q);
    for (let i = 0; i < ns; i++) {
      const sooty = i < ns * 0.22;
      const a = Math.random() * Math.PI * 2;
      _dir.copy(_t).multiplyScalar(Math.cos(a)).addScaledVector(_b, Math.sin(a));
      s = _spawn.reset();
      s.setPosition(g).offset(_dir, rand(0, sooty ? 0.8 : 2.0)).offset(n, rand(0.2, 1.0));
      s.setVelocity(_tan, 0.3).addVelocity(_dir, rand(1.2, sooty ? 2.5 : 4.8)).addVelocity(n, rand(0.6, 2.2));
      s.life = rand(2.0, 3.6);
      s.size0 = rand(0.5, 1.1);
      s.size1 = rand(2.6, 5.2);
      s.sizeEase = 2.2;
      if (sooty) s.color0(C_SOOT, 0.42).color1(C_DUST, 0);
      else s.color0(C_DUST, 0.34).color1(C_DUST_END, 0);
      s.fadeIn = 0.06;
      s.fadeOut = 0.6;
      s.rot = Math.random() * 6.28;
      s.rotSpeed = randSigned() * 0.4;
      s.drag = 1.6;
      s.gravity = -0.05;
      s.softPlane(n, g, 0.5);
      s.blob = 0.75;
      s.sprite = randomSmokeSprite();
      fx.smoke.spawn(s);
    }
  }

  return null;
}
