/**
 * LandingFX — touchdown feedback.
 *  - 'landing' / 'wheelSlam': radial dust ring hugging the surface + expanding ground shockwave,
 *    both scaled by impact.
 *  - PERFECT landing: tasteful celebration — cyan/white sparkle fountain, a clean expanding cyan
 *    ring (+ a delayed thin white one), a brief light pillar and a short cyan light flash.
 */
import { useEffect, useMemo } from 'react';
import {
  CylinderGeometry,
  DoubleSide,
  Mesh,
  Quaternion,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
} from 'three';
import { runtime } from '@/game/runtime';
import type { LandingResult, SimSnapshot } from '@/game/types';
import { VEHICLE } from '@/game/vehicleSpec';
import { PALETTE } from '@/render/palette';
import { ADDITIVE } from '../core/blending';
import { FX_ORDER, type FXFrameContext } from '../core/FXSystem';
import { FOG_FRAG_GLSL, OUTPUT_FRAG_GLSL } from '../core/glsl';
import { disableRaycast } from '../core/objects';
import { clamp, linearColor, linearRGB, rand, randSigned, smoothstep, tangentBasis } from '../core/math';
import { ParticleSpawn, SPRITE_GLOW } from '../core/ParticlePool';
import { RingSpawn } from '../core/RingWavePool';
import { useFX, useFXFrame, useFXReset } from '../FXContext';
import { useConst } from '../core/useConst';

const RIDE = -VEHICLE.groundY;
/** Slams within this time of the touchdown's first slam pulse belong to the same touchdown (s). */
const SLAM_MERGE_WINDOW = 0.12;
/** A landing this soon after a slam pulse is the same touchdown (the sim's touchdown window is 0.15 s). */
const SLAM_LANDING_WINDOW = 0.35;
const PILLAR_LIFE = 0.75;
/** Pillar height (m). */
const PILLAR_HEIGHT = 13;
const C_DUST = linearRGB('#e2ddd3');
const C_SHOCK = linearRGB('#fbf6ec');
const C_CYAN = linearRGB(PALETTE.cyanGlow);
const C_CYAN_DEEP = linearRGB(PALETTE.cyan);
const C_WHITE = linearRGB(PALETTE.warmWhite);

const PILLAR_VERT = /* glsl */ `
varying float vH;
varying vec3 vNormalV;
varying vec3 vViewV;
#include <fog_pars_vertex>
void main() {
  vH = position.y;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vNormalV = normalize(normalMatrix * normal);
  vViewV = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const PILLAR_FRAG = /* glsl */ `
uniform float uT;        // 0..1 over the pillar life
uniform float uEmissive; // theme compensation * camera proximity fade
uniform vec3 uBase;
uniform vec3 uTop;
varying float vH;
varying vec3 vNormalV;
varying vec3 vViewV;
#include <fog_pars_fragment>
${FOG_FRAG_GLSL}
void main() {
  float facing = abs(dot(normalize(vNormalV), normalize(vViewV)));
  float soft = pow(facing, 2.2); // soft cylindrical edges
  float h = clamp(vH, 0.0, 1.0); // MSAA-safe (no negative pow base)
  // the column shoots up: visible below a front that climbs fast, a bright band rides the front
  float front = smoothstep(0.0, 0.4, uT);
  float reach = 1.0 - smoothstep(front - 0.3, front, h);
  float band = exp(-pow((h - front * 0.92) * 7.0, 2.0)) * 0.9;
  float env = smoothstep(0.0, 0.05, uT) * pow(1.0 - uT, 1.7);
  // soft contact with the ground (no hard ellipse where the cylinder meets the surface)
  float base = smoothstep(0.0, 0.045, h);
  float a = soft * env * base * (reach * pow(1.0 - h, 2.4) + band * (1.0 - h));
  vec3 col = mix(uBase, uTop, smoothstep(0.0, 0.55, h)) * (a * uEmissive);
  gl_FragColor = vec4(fx_applyFog(col, 0.0), 1.0);
  ${OUTPUT_FRAG_GLSL}
}
`;

const _ground = new Vector3();
const _normal = new Vector3();
const _t = new Vector3();
const _b = new Vector3();
const _dir = new Vector3();
const _p = new Vector3();
const _q = new Quaternion();
const _up = new Vector3(0, 1, 0);
const _pillarAxis = new Vector3();
const _slamP = new Vector3();
const _spawn = new ParticleSpawn();
const _ring = new RingSpawn();

/** Contact normal of the first grounded wheel, if any. */
function firstContactNormal(snapshot: SimSnapshot): Vector3 | null {
  const wheels = snapshot.vehicle.wheels;
  for (let i = 0; i < wheels.length; i++) if (wheels[i].grounded) return wheels[i].contactNormal;
  return null;
}

/** Ground point + normal under the car at touchdown (wheel contacts, else pose-based fallback). */
function touchdownPlane(snapshot: SimSnapshot, fallbackPos: Vector3, outP: Vector3, outN: Vector3): void {
  const v = snapshot.vehicle;
  let k = 0;
  outP.set(0, 0, 0);
  outN.set(0, 0, 0);
  for (let i = 0; i < v.wheels.length; i++) {
    const w = v.wheels[i];
    if (!w.grounded) continue;
    outP.add(w.contactPoint);
    outN.add(w.contactNormal);
    k++;
  }
  if (k > 0 && outN.lengthSq() > 1e-6) {
    outP.multiplyScalar(1 / k);
    outN.normalize();
    // center under the chassis rather than the mean of the touching wheels
    _p.copy(v.position).sub(outP);
    outP.add(_p.addScaledVector(outN, -_p.dot(outN)));
    return;
  }
  outN.copy(v.up.lengthSq() > 0.5 ? v.up : _up);
  outP.copy(fallbackPos).addScaledVector(outN, -RIDE);
}

export function LandingFX() {
  const fx = useFX();
  const pillar = useMemo(() => {
    const g = new CylinderGeometry(0.42, 0.85, 1, 48, 1, true);
    g.translate(0, 0.5, 0);
    const m = new ShaderMaterial({
      name: 'fx-light-pillar',
      uniforms: {
        ...UniformsUtils.clone(UniformsLib.fog),
        uT: { value: 1 },
        uEmissive: { value: 1 },
        uBase: { value: linearColor(PALETTE.cyanGlow, 0.8).lerp(linearColor(PALETTE.warmWhite, 0.8), 0.45) },
        uTop: { value: linearColor(PALETTE.cyanGlow, 0.55) },
      },
      vertexShader: PILLAR_VERT,
      fragmentShader: PILLAR_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      ...ADDITIVE,
      side: DoubleSide,
      fog: true,
    });
    const mesh = disableRaycast(new Mesh(g, m));
    mesh.name = 'fx-light-pillar';
    mesh.frustumCulled = false;
    mesh.renderOrder = FX_ORDER.volumes;
    mesh.visible = false;
    return mesh;
  }, []);

  const st = useConst(() => ({
    queue: [] as { kind: 'landing' | 'slam'; result?: LandingResult; position: Vector3; strength: number }[],
    lastLandingTime: -Infinity,
    lastLandingPerfect: false,
    /** FX time and dust scale of the last wheel-slam pulse (a touchdown = up to 4 slams + 1 landing). */
    lastSlamTime: -Infinity,
    lastSlamScale: 0,
    pillarStart: -Infinity,
  }));

  useEffect(() => {
    const offLanding = runtime.events.on('landing', (e) => {
      st.queue.push({ kind: 'landing', result: e.result, position: e.result.position.clone(), strength: 1 });
    });
    const offSlam = runtime.events.on('wheelSlam', (e) => {
      st.queue.push({ kind: 'slam', position: e.position.clone(), strength: e.strength });
    });
    return () => {
      offLanding();
      offSlam();
    };
  }, [st]);

  useFXReset(() => {
    st.queue.length = 0;
    st.lastLandingTime = -Infinity;
    st.lastLandingPerfect = false;
    st.lastSlamTime = -Infinity;
    st.lastSlamScale = 0;
    st.pillarStart = -Infinity;
    pillar.visible = false;
  });

  useEffect(
    () => () => {
      pillar.geometry.dispose();
      pillar.material.dispose();
    },
    [pillar],
  );

  useFXFrame((ctx: FXFrameContext) => {
    const { time, dt } = ctx;
    // Landings first, then slams. A touchdown on four wheels emits up to four 'wheelSlam' events at
    // contact (same tick or a few ticks apart) and the 'landing' ~0.15 s later (end of the
    // touchdown window): they are coalesced into ONE dust skirt + shockwave, so a touchdown reads as
    // a single pulse instead of overlapping ripples.
    if (st.queue.length > 0 && dt > 0) {
      const queue = st.queue;
      for (let i = 0; i < queue.length; i++) {
        const ev = queue[i];
        if (ev.kind === 'landing' && ev.result) onLanding(ctx, ev.result);
      }
      let slams = 0;
      let strength = 0;
      _slamP.set(0, 0, 0);
      for (let i = 0; i < queue.length; i++) {
        const ev = queue[i];
        if (ev.kind !== 'slam') continue;
        _slamP.add(ev.position);
        strength = Math.max(strength, ev.strength);
        slams++;
      }
      if (slams > 0) onSlam(ctx, _slamP.multiplyScalar(1 / slams), strength);
      queue.length = 0;
    }
    // light pillar
    const t = (time - st.pillarStart) / PILLAR_LIFE;
    if (t >= 0 && t < 1) {
      pillar.visible = true;
      const w = 1 + 0.15 * t;
      pillar.scale.set(w, PILLAR_HEIGHT, w);
      pillar.material.uniforms.uT.value = t;
      // fade when the camera gets close to the shaft (it would fill the frame like a glass tube)
      ctx.camera.getWorldPosition(_p);
      _p.sub(pillar.position);
      const axial = _p.dot(_pillarAxis.set(0, 1, 0).applyQuaternion(pillar.quaternion));
      const radial = Math.sqrt(Math.max(0, _p.lengthSq() - axial * axial));
      pillar.material.uniforms.uEmissive.value = ctx.emissive * smoothstep(2.2, 5.5, radial);
    } else {
      pillar.visible = false;
    }
  });

  /**
   * Low, fast dust skirt shooting out along the surface: velocity-stretched puffs (radial dust jets)
   * that slow down, widen and settle quickly.
   */
  function dustRing(ctx: FXFrameContext, p: Vector3, n: Vector3, scale: number, countBase: number) {
    const v = ctx.snapshot.vehicle;
    tangentBasis(n, _t, _b);
    const count = Math.round(countBase * Math.max(0.5, ctx.quality));
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + randSigned() * 0.3;
      _dir.copy(_t).multiplyScalar(Math.cos(a)).addScaledVector(_b, Math.sin(a));
      const s = _spawn.reset();
      s.setPosition(p).offset(_dir, rand(1.1, 1.8)).offset(n, rand(0.12, 0.3));
      // inherit the tangential part of the car velocity
      s.setVelocity(v.velocity, 0.4);
      const vn = s.vx * n.x + s.vy * n.y + s.vz * n.z;
      s.vx -= n.x * vn;
      s.vy -= n.y * vn;
      s.vz -= n.z * vn;
      s.addVelocity(_dir, rand(7, 12) * scale).addVelocity(n, rand(0.2, 0.7));
      s.life = rand(0.8, 1.4);
      s.size0 = rand(0.7, 1.0);
      s.size1 = rand(1.8, 2.8) * Math.sqrt(scale);
      s.sizeEase = 2.2;
      s.color0(C_DUST, 0.22).color1(C_DUST, 0);
      s.fadeIn = 0.03;
      s.fadeOut = 0.65;
      s.stretch = 0.07; // elongated along the outward motion while fast, round once settled
      s.drag = 3.2;
      s.gravity = -0.02;
      s.softPlane(n, p, 0.35);
      s.sprite = SPRITE_GLOW;
      fx.smoke.spawn(s);
    }
  }

  function shockwave(p: Vector3, n: Vector3, scale: number, alpha: number) {
    const r = _ring.reset();
    r.center.copy(p);
    r.normal.copy(n);
    r.kind = 'shock';
    r.r0 = 1.4;
    r.r1 = 3.5 + 4.5 * scale;
    r.life = 0.32 + 0.16 * scale;
    r.thickness = 0.22 + 0.1 * scale;
    r.alpha = alpha;
    r.color = C_SHOCK;
    r.additive = 0.15;
    fx.rings.spawn(r);
  }

  function onLanding(ctx: FXFrameContext, result: LandingResult) {
    st.lastLandingTime = ctx.time;
    st.lastLandingPerfect = result.quality === 'perfect';
    touchdownPlane(ctx.snapshot, result.position, _ground, _normal);
    const impact = clamp(result.impactSpeed / 14, 0.25, 1.6);
    const qualityBoost = result.quality === 'crash' ? 1.3 : result.quality === 'hard' ? 1.15 : 1;
    const scale = impact * qualityBoost;
    // The wheel slams of this touchdown (if any) already raised the dust pulse at contact: only add
    // what a heavier-than-expected landing (hard / crash) is missing.
    const slamPulse = ctx.time - st.lastSlamTime < SLAM_LANDING_WINDOW;
    const extra = slamPulse ? scale - st.lastSlamScale : scale;
    // a PERFECT touchdown only kisses the ground: no dust skirt (the tire chirp is enough)
    if (result.quality !== 'perfect') {
      if (!slamPulse) dustRing(ctx, _ground, _normal, scale, 14 + 26 * scale);
      else if (extra > 0.25) dustRing(ctx, _ground, _normal, scale, 6 + 22 * extra);
    }
    if (!slamPulse || extra > 0.25) shockwave(_ground, _normal, scale, clamp(0.2 + 0.14 * scale, 0, 0.42));
    if (result.quality === 'perfect') celebrate(ctx, _ground, _normal);
  }

  /** One coalesced cluster of wheel slams (`position` = mean contact point, `strength` = max). */
  function onSlam(ctx: FXFrameContext, position: Vector3, strength: number) {
    _normal.copy(firstContactNormal(ctx.snapshot) ?? _up);
    const sinceLanding = ctx.time - st.lastLandingTime;
    const sinceSlam = ctx.time - st.lastSlamTime;
    if (sinceLanding < 0.2 || sinceSlam < SLAM_MERGE_WINDOW) {
      // part of a touchdown that already raised its pulse (landing just evaluated, or the other
      // wheels of the same touchdown a few ticks earlier): only a few extra puffs at the contact
      // point, none for a PERFECT touchdown, which should stay clean
      if (!(sinceLanding < 0.2 && st.lastLandingPerfect)) dustRing(ctx, position, _normal, 0.5 + 0.4 * strength, 3 + 5 * strength);
      return;
    }
    const scale = 0.45 + 0.6 * strength;
    st.lastSlamTime = ctx.time;
    st.lastSlamScale = scale;
    dustRing(ctx, position, _normal, scale, 10 + 20 * strength);
    shockwave(position, _normal, 0.3 + 0.5 * strength, 0.16 + 0.2 * strength);
  }

  function celebrate(ctx: FXFrameContext, p: Vector3, n: Vector3) {
    const v = ctx.snapshot.vehicle;
    tangentBasis(n, _t, _b);
    // fine motes kicked up around the footprint: rise, twinkle, fade (no confetti burst)
    _p.copy(v.velocity).addScaledVector(n, -v.velocity.dot(n));
    const count = Math.round(34 * ctx.quality + 16);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      _dir.copy(_t).multiplyScalar(Math.cos(a)).addScaledVector(_b, Math.sin(a));
      const s = _spawn.reset();
      s.setPosition(p).offset(_dir, rand(1.5, 3.0)).offset(n, rand(0.05, 0.5));
      s.setVelocity(_p, 0.4).addVelocity(n, rand(1.5, 4.8)).addVelocity(_dir, rand(0.3, 1.6));
      s.life = rand(0.8, 1.5);
      s.size0 = rand(0.05, 0.09);
      s.size1 = 0.02;
      const cyan = Math.random() < 0.65;
      s.color0(cyan ? C_CYAN : C_WHITE, 1, 4).color1(C_CYAN_DEEP, 0, 1.4);
      s.fadeIn = 0.08;
      s.fadeOut = 0.5;
      s.twinkle = 0.6;
      s.stretch = 0.025;
      s.drag = 1.3;
      s.gravity = -0.05;
      s.sprite = SPRITE_GLOW;
      fx.glow.spawn(s);
    }
    // clean expanding cyan ring + delayed thin white ring + soft disc flash
    let r = _ring.reset();
    r.center.copy(p);
    r.normal.copy(n);
    r.kind = 'ring';
    r.r0 = 2;
    r.r1 = 13;
    r.life = 1.0;
    r.thickness = 0.075;
    r.color = [C_CYAN[0] * 2.4, C_CYAN[1] * 2.4, C_CYAN[2] * 2.4];
    r.alpha = 1;
    r.additive = 1;
    r.lift = 0.04;
    fx.rings.spawn(r);
    r = _ring.reset();
    r.center.copy(p);
    r.normal.copy(n);
    r.kind = 'ring';
    r.r0 = 1.6;
    r.r1 = 8.5;
    r.life = 0.8;
    r.delay = 0.12;
    r.thickness = 0.04;
    r.color = [C_WHITE[0] * 1.6, C_WHITE[1] * 1.6, C_WHITE[2] * 1.6];
    r.alpha = 0.9;
    r.additive = 1;
    r.lift = 0.045;
    fx.rings.spawn(r);
    r = _ring.reset();
    r.center.copy(p);
    r.normal.copy(n);
    r.kind = 'flash';
    r.r0 = 2.2;
    r.r1 = 3.6;
    r.life = 0.45;
    r.color = [C_CYAN[0] * 0.9, C_CYAN[1] * 0.9, C_CYAN[2] * 0.9];
    r.alpha = 0.32;
    r.additive = 1;
    fx.rings.spawn(r);
    // light pillar
    pillar.position.copy(p);
    _q.setFromUnitVectors(_up, n);
    pillar.quaternion.copy(_q);
    st.pillarStart = ctx.time;
    // flash light
    _p.copy(p).addScaledVector(n, 1.6);
    fx.flash(_p, C_CYAN, 34, 0.55);
  }

  return <primitive object={pillar} />;
}
