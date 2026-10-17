/**
 * VacuumFX — visual language of the vacuum adhesion system (Level 3).
 *  - Skirt glow: thin cyan rounded-rectangle light line under the floor whenever mode !== 'off'
 *    (faint slow pulse while armed, bright shimmer while engaged).
 *  - Underglow / contact glow decal on the surface below (oriented to surfaceNormal, aligned with
 *    the car heading): light spill when armed near a surface, strong contact glow with inward
 *    suction ripples when engaged.
 *  - Airflow motes streaming into the skirt while engaged; a subtle tether column when the
 *    surface is > 0.6 m away.
 *  - Pulse on 'vacuumEngaged': a crisp outline expanding from the skirt, drawn in the car frame
 *    (a world-space decal would sink into the curved L3 crescent surfaces); dissipating puff on
 *    'vacuumReleased'.
 */
import { useEffect, useMemo } from 'react';
import {
  CylinderGeometry,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector2,
  Vector3,
} from 'three';
import { runtime } from '@/game/runtime';
import { VACUUM_SKIRT } from '@/game/vehicleSpec';
import { PALETTE } from '@/render/palette';
import { ADDITIVE } from '../core/blending';
import { FX_ORDER, type FXFrameContext } from '../core/FXSystem';
import { FOG_FRAG_GLSL, OUTPUT_FRAG_GLSL } from '../core/glsl';
import { disableRaycast } from '../core/objects';
import { damp, linearColor, linearRGB, projectOnPlaneSafe, rand, randSigned, RateAccumulator, smoothstep } from '../core/math';
import { ParticleSpawn, SPRITE_GLOW } from '../core/ParticlePool';
import { useFX, useFXFrame, useFXReset } from '../FXContext';
import { useConst } from '../core/useConst';

const HW = VACUUM_SKIRT.halfWidth;
const HL = VACUUM_SKIRT.halfLength;
const FLOOR = VACUUM_SKIRT.y;
const C_CYAN = linearRGB(PALETTE.cyan);
const C_CYAN_GLOW = linearRGB(PALETTE.cyanGlow);
const C_PUFF = linearRGB('#e2f3f6');
/** How far the engage pulse expands beyond the skirt outline (m) and its duration (s). */
const PULSE_REACH = 2.4;
const PULSE_TIME = 0.6;

const SDF_GLSL = /* glsl */ `
float sdRoundRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
`;

/** Thin light line around the skirt (chassis-attached, in the floor plane). */
const SKIRT_VERT = /* glsl */ `
uniform vec2 uSize;
varying vec2 vLocal;
#include <fog_pars_vertex>
void main() {
  vLocal = position.xy * uSize;
  vec3 p = vec3(vLocal.x, 0.0, vLocal.y);
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;
const SKIRT_FRAG = /* glsl */ `
uniform vec2 uHalf;
uniform float uIntensity;
uniform float uTime;
uniform float uPulse;   // engage pulse progress 0..1 (>= 1: none)
uniform vec3 uColor;
uniform vec3 uPulseColor;
varying vec2 vLocal;
${SDF_GLSL}
#include <fog_pars_fragment>
${FOG_FRAG_GLSL}
void main() {
  float d = sdRoundRect(vLocal, uHalf, 0.32);
  float aa = fwidth(d);
  float line = 1.0 - smoothstep(0.012, 0.03 + aa, abs(d));
  float halo = exp(-abs(d) * 12.0) * 0.4;
  float fill = (1.0 - smoothstep(-0.25, 0.0, d)) * 0.1;
  float shimmer = 0.85 + 0.15 * sin(vLocal.y * 7.0 - uTime * 11.0);
  vec3 col = uColor * ((line * 1.4 + halo + fill) * shimmer * uIntensity);
  // engage pulse: a crisp outline expanding outwards from the skirt, plus a brief inner flash
  if (uPulse < 1.0) {
    float e = 1.0 - pow(1.0 - uPulse, 2.4);
    float r = e * ${PULSE_REACH.toFixed(2)};
    float w = 0.03 + 0.05 * e;
    float ring = 1.0 - smoothstep(w, w + aa * 1.5, abs(d - r));
    float glow = exp(-abs(d - r) * 7.0) * 0.35;
    float flash = (1.0 - smoothstep(-0.6, 0.15, d)) * (1.0 - smoothstep(0.0, 0.35, uPulse)) * 0.6;
    col += uPulseColor * ((ring + glow) * pow(1.0 - uPulse, 1.3) + flash);
  }
  gl_FragColor = vec4(fx_applyFog(col, 0.0), 1.0);
  ${OUTPUT_FRAG_GLSL}
}
`;

/** Surface decal: underglow spill / contact glow with suction ripples. */
const DECAL_VERT = /* glsl */ `
uniform vec2 uSize;
varying vec2 vLocal;
#include <fog_pars_vertex>
void main() {
  vLocal = position.xy * uSize;
  vec4 mvPosition = modelViewMatrix * vec4(vLocal, 0.0, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;
const DECAL_FRAG = /* glsl */ `
uniform vec2 uHalf;
uniform vec2 uSize;
uniform float uIntensity;
uniform float uEngaged;
uniform float uDist;     // skirt -> surface distance (m)
uniform float uTime;
uniform vec3 uColor;
uniform vec3 uCore;
varying vec2 vLocal;
${SDF_GLSL}
#include <fog_pars_fragment>
${FOG_FRAG_GLSL}
void main() {
  // light projected from the skirt: the footprint softens and spreads with distance
  float spread = min(uDist, 3.0);
  float d = sdRoundRect(vLocal, uHalf, 0.45 + 0.35 * spread);
  // window: everything reaches exactly zero before the quad border (no visible rectangle)
  vec2 q = abs(vLocal) / uSize;
  float window = 1.0 - smoothstep(0.55, 0.98, max(q.x, q.y));
  float spill = exp(-max(d, 0.0) * 2.6 / (1.0 + 0.8 * spread)) * window;
  float inner = 1.0 - smoothstep(-0.9 - 0.3 * spread, 0.05 + 0.45 * spread, d);
  // the sealed contact (bright edge + inward suction ripples) only exists close to the surface
  float contact = 1.0 - smoothstep(0.35, 1.1, uDist);
  float edge = exp(-abs(d) * 6.0);
  float rip = pow(0.5 + 0.5 * sin(d * 10.0 + uTime * 10.0), 3.0) * (1.0 - smoothstep(0.0, 1.3, abs(d + 0.2)));
  // hovering: slow soft pulses converging under the skirt
  float pulse = pow(0.5 + 0.5 * sin(d * 4.0 + uTime * 6.0), 4.0) * (1.0 - smoothstep(-0.5, 1.5, d)) * 0.25;
  vec3 col = uColor * (spill * 0.34 + inner * 0.14)
    + uCore * (uEngaged * window * (contact * (edge * 0.55 + rip * 0.35) + (1.0 - contact) * pulse));
  col *= uIntensity / (1.0 + 0.35 * spread);
  gl_FragColor = vec4(fx_applyFog(col, 0.0), 1.0);
  ${OUTPUT_FRAG_GLSL}
}
`;

/** Tether column between the skirt and a distant surface. */
const TETHER_VERT = /* glsl */ `
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
const TETHER_FRAG = /* glsl */ `
uniform float uIntensity;
uniform float uTime;
uniform float uLength;
uniform vec3 uColor;
varying float vH;
varying vec3 vNormalV;
varying vec3 vViewV;
#include <fog_pars_fragment>
${FOG_FRAG_GLSL}
void main() {
  float facing = abs(dot(normalize(vNormalV), normalize(vViewV)));
  float soft = pow(facing, 2.5);
  // thin soft rings travelling from the surface (h = 0) up into the skirt (h = 1): suction flow
  float bands = 0.5 + 0.5 * sin((clamp(vH, 0.0, 1.0) * uLength * 1.8 - uTime * 4.5) * 6.2831853);
  bands = pow(bands, 6.0);
  float h = clamp(vH, 0.0, 1.0);
  float ends = smoothstep(0.0, 0.3, h) * (1.0 - smoothstep(0.75, 1.0, h));
  float a = soft * ends * (0.04 + 0.13 * bands) * uIntensity;
  gl_FragColor = vec4(fx_applyFog(uColor * a, 0.0), 1.0);
  ${OUTPUT_FRAG_GLSL}
}
`;

function additiveMaterial(name: string, vert: string, frag: string, uniforms: Record<string, { value: unknown }>): ShaderMaterial {
  return new ShaderMaterial({
    name,
    uniforms: { ...UniformsUtils.clone(UniformsLib.fog), ...uniforms },
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    ...ADDITIVE,
    side: DoubleSide,
    fog: true,
  });
}

// scratch
const _m = new Matrix4();
const _n = new Vector3();
const _sp = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _p = new Vector3();
const _local = new Vector3();
const _dir = new Vector3();
const _floor = new Vector3();
const _spawn = new ParticleSpawn();

/** Random point on the skirt outline (chassis local, floor plane) + its outward normal. */
function skirtPerimeterPoint(outPos: Vector3, outNormal: Vector3): void {
  const u = Math.random() * 2 * (HW + HL); // long vs short sides weighted by length
  const side = Math.random() < 0.5 ? -1 : 1;
  if (u < 2 * HL) {
    outPos.set(side * HW, FLOOR, u - HL);
    outNormal.set(side, 0, 0);
  } else {
    outPos.set(u - 2 * HL - HW, FLOOR, side * HL);
    outNormal.set(0, 0, side);
  }
}

export function VacuumFX() {
  const fx = useFX();
  const res = useMemo(() => {
    const root = new Group();
    root.name = 'fx-vacuum';

    // skirt light line (child of a car-following group)
    const car = new Group();
    const skirtMat = additiveMaterial('fx-vacuum-skirt', SKIRT_VERT, SKIRT_FRAG, {
      // quad large enough for the engage pulse to expand into
      uSize: { value: new Vector2(HW + PULSE_REACH + 0.4, HL + PULSE_REACH + 0.4) },
      uHalf: { value: new Vector2(HW + 0.04, HL + 0.04) },
      uIntensity: { value: 0 },
      uTime: { value: 0 },
      uPulse: { value: 1 },
      uColor: { value: linearColor(PALETTE.cyan, 1.6) },
      uPulseColor: { value: linearColor(PALETTE.cyanGlow, 2.2) },
    });
    const skirt = disableRaycast(new Mesh(new PlaneGeometry(2, 2), skirtMat));
    skirt.position.y = FLOOR - 0.02;
    skirt.frustumCulled = false;
    skirt.renderOrder = FX_ORDER.glow;
    car.add(skirt);
    root.add(car);

    // surface decal (world)
    const decalMat = additiveMaterial('fx-vacuum-decal', DECAL_VERT, DECAL_FRAG, {
      uSize: { value: new Vector2(HW + 1.7, HL + 1.7) },
      uHalf: { value: new Vector2(HW + 0.1, HL + 0.1) },
      uIntensity: { value: 0 },
      uEngaged: { value: 0 },
      uDist: { value: 0 },
      uTime: { value: 0 },
      uColor: { value: linearColor(PALETTE.cyan, 0.9) },
      uCore: { value: linearColor(PALETTE.cyanGlow, 1.4) },
    });
    decalMat.polygonOffset = true;
    decalMat.polygonOffsetFactor = -2;
    decalMat.polygonOffsetUnits = -4;
    const decal = disableRaycast(new Mesh(new PlaneGeometry(2, 2), decalMat));
    decal.frustumCulled = false;
    decal.renderOrder = FX_ORDER.decals;
    decal.visible = false;
    root.add(decal);

    // tether column (unit cylinder, base at y = 0)
    const tg = new CylinderGeometry(0.9, 1, 1, 36, 1, true);
    tg.translate(0, 0.5, 0);
    const tetherMat = additiveMaterial('fx-vacuum-tether', TETHER_VERT, TETHER_FRAG, {
      uIntensity: { value: 0 },
      uTime: { value: 0 },
      uLength: { value: 1 },
      uColor: { value: linearColor(PALETTE.cyan, 0.9) },
    });
    const tether = disableRaycast(new Mesh(tg, tetherMat));
    tether.frustumCulled = false;
    tether.renderOrder = FX_ORDER.volumes;
    tether.visible = false;
    root.add(tether);

    return { root, car, skirt, decal, tether };
  }, []);

  const st = useConst(() => ({
    glow: 0,
    decal: 0,
    engaged: 0,
    tether: 0,
    air: new RateAccumulator(),
    engaged0: false,
    releasedEvent: false,
    /** FX time of the last engage pulse. */
    pulseStart: -Infinity,
  }));

  useEffect(() => {
    const offEngaged = runtime.events.on('vacuumEngaged', () => {
      st.engaged0 = true;
    });
    const offReleased = runtime.events.on('vacuumReleased', () => {
      st.releasedEvent = true;
    });
    return () => {
      offEngaged();
      offReleased();
    };
  }, [st]);

  useFXReset(() => {
    st.glow = st.decal = st.engaged = st.tether = 0;
    st.engaged0 = false;
    st.releasedEvent = false;
    st.pulseStart = -Infinity;
    st.air.reset();
    res.skirt.visible = res.decal.visible = res.tether.visible = false;
  });

  useEffect(
    () => () => {
      for (const m of [res.skirt, res.decal, res.tether]) {
        m.geometry.dispose();
        m.material.dispose();
      }
    },
    [res],
  );

  useFXFrame((ctx: FXFrameContext) => {
    const { frame, snapshot, time, dt } = ctx;
    const v = snapshot.vehicle;
    const vac = v.vacuum;
    const { car, skirt, decal, tether } = res;
    car.position.copy(frame.position);
    car.quaternion.copy(frame.quaternion);
    car.updateMatrixWorld();

    const engaged = vac.mode === 'engaged';
    const on = vac.available && vac.mode !== 'off' && !v.crashed;
    // surface for the decal: vacuum surface if any, else the driving surface / ground below
    let surface = false;
    if (vac.hasSurface && Number.isFinite(vac.distance)) {
      _n.copy(vac.surfaceNormal);
      _sp.copy(vac.surfacePoint);
      surface = true;
    } else if (v.groundedWheels > 0) {
      _n.set(0, 0, 0);
      _sp.set(0, 0, 0);
      let k = 0;
      for (let i = 0; i < v.wheels.length; i++) {
        const w = v.wheels[i];
        if (!w.grounded) continue;
        _n.add(w.contactNormal);
        _sp.add(w.contactPoint);
        k++;
      }
      // groundedWheels and the per-wheel flags can disagree for a tick: no average -> no surface
      if (k > 0 && _n.lengthSq() > 1e-8) {
        _sp.multiplyScalar(1 / k);
        _n.normalize();
        surface = true;
      }
    }
    const dist = surface ? Math.max(0, (vac.hasSurface && Number.isFinite(vac.distance) ? vac.distance : 0.12)) : Infinity;

    // smoothed intensities (frozen while paused)
    if (dt > 0) {
      const glowT = !on ? 0 : engaged ? 0.75 + 0.45 * vac.strength : 0.2 + 0.07 * Math.sin(time * 3.2);
      st.glow += (glowT - st.glow) * damp(on ? 10 : 6, dt);
      const reach = 1 - smoothstep(1.2, 4.5, dist);
      const decalT = !on || !surface ? 0 : (engaged ? 0.55 + 0.6 * vac.strength : 0.16) * reach;
      st.decal += (decalT - st.decal) * damp(8, dt);
      st.engaged += ((engaged ? vac.strength : 0) - st.engaged) * damp(10, dt);
      const tetherT = engaged && dist > 0.6 ? vac.strength * smoothstep(0.6, 1.3, dist) * (1 - smoothstep(4, 5, dist)) : 0;
      st.tether += (tetherT - st.tether) * damp(8, dt);
    }

    // skirt line (+ engage pulse)
    if (st.engaged0 && dt > 0) {
      st.engaged0 = false;
      st.pulseStart = time;
    }
    const pulse = (time - st.pulseStart) / PULSE_TIME;
    skirt.visible = st.glow > 0.01 || pulse < 1;
    if (skirt.visible) {
      const u = (skirt.material as ShaderMaterial).uniforms;
      u.uIntensity.value = st.glow * ctx.emissive;
      u.uTime.value = time;
      u.uPulse.value = pulse < 1 ? pulse : 1;
    }

    // surface decal: on the plane, aligned with the car heading projected on it
    decal.visible = st.decal > 0.01 && surface;
    if (decal.visible) {
      projectOnPlaneSafe(_fwd.set(0, 0, -1).applyQuaternion(frame.quaternion), _n);
      _right.crossVectors(_fwd, _n).normalize();
      // right-handed plane basis: x = right, y = forward, z = surface normal
      _m.makeBasis(_right, _fwd, _n);
      decal.quaternion.setFromRotationMatrix(_m);
      // center under the skirt (project the car position on the plane)
      _local.copy(frame.position).sub(_sp);
      // small lift: the decal is planar, the L3 crescent surfaces are curved
      decal.position.copy(frame.position).addScaledVector(_n, -_local.dot(_n) + 0.05);
      const u = (decal.material as ShaderMaterial).uniforms;
      u.uIntensity.value = st.decal * ctx.emissive;
      u.uEngaged.value = st.engaged;
      u.uDist.value = Number.isFinite(dist) ? dist : 0;
      u.uTime.value = time;
    }

    // tether column from the surface up to the floor center
    tether.visible = st.tether > 0.01 && surface;
    if (tether.visible) {
      _floor.set(0, FLOOR, 0).applyMatrix4(car.matrixWorld);
      _local.copy(_floor).sub(_sp);
      const along = _local.dot(_n);
      tether.position.copy(_floor).addScaledVector(_n, -along);
      // orient the column's local Y along the normal, local Z along the car's length
      projectOnPlaneSafe(_fwd.set(0, 0, 1).applyQuaternion(frame.quaternion), _n);
      _right.crossVectors(_n, _fwd).normalize();
      _m.makeBasis(_right, _n, _fwd);
      tether.quaternion.setFromRotationMatrix(_m);
      const len = Math.max(0.1, along);
      // elliptical column matching the skirt footprint (local x = right, z = forward/back)
      tether.scale.set(HW * 0.62, len, HL * 0.5);
      const u = (tether.material as ShaderMaterial).uniforms;
      u.uIntensity.value = st.tether * ctx.emissive;
      u.uTime.value = time;
      u.uLength.value = len;
    }

    if (dt <= 0) return;
    const q = ctx.quality;

    // airflow streaming into the skirt
    if (engaged && !v.crashed) {
      const count = st.air.take(110 * vac.strength * q, dt, 10);
      for (let k = 0; k < count; k++) {
        skirtPerimeterPoint(_local, _dir);
        const out = rand(0.6, 1.7);
        const speed = rand(4.5, 8);
        _local.addScaledVector(_dir, out);
        _local.y = FLOOR - rand(0, Math.min(0.35, Math.max(0.05, dist)));
        _p.copy(_local).applyMatrix4(car.matrixWorld);
        // inward (+ slightly up into the skirt), in world space
        _dir.multiplyScalar(-1).applyQuaternion(frame.quaternion);
        _dir.addScaledVector(v.up, 0.18).normalize();
        const s = _spawn.reset();
        s.setPosition(_p);
        s.setVelocity(v.velocity).addVelocity(_dir, speed);
        s.age = Math.random() * dt;
        s.life = (out / speed) * rand(0.8, 1.05);
        s.size0 = rand(0.035, 0.055);
        s.size1 = 0.018;
        s.color0(C_CYAN_GLOW, 0.85, 2.6).color1(C_CYAN, 0.0, 1.6);
        s.fadeIn = 0.3;
        s.fadeOut = 0.3;
        s.stretch = 0.06;
        s.sprite = SPRITE_GLOW;
        fx.glow.spawn(s);
      }
      // motes rising along the tether when the surface is far
      if (st.tether > 0.1 && surface) {
        const nt = Math.round(count * 0.5);
        for (let k = 0; k < nt; k++) {
          _floor.set(randSigned() * 0.5, FLOOR, randSigned() * 0.9).applyMatrix4(car.matrixWorld);
          _local.copy(_floor).sub(_sp);
          const along = _local.dot(_n);
          _p.copy(_floor).addScaledVector(_n, -along * rand(0.6, 1.0));
          _dir.copy(_floor).sub(_p);
          const len = _dir.length();
          if (len < 0.05) continue;
          _dir.multiplyScalar(1 / len);
          const sp = rand(5, 9);
          const s = _spawn.reset();
          s.setPosition(_p);
          s.setVelocity(v.velocity).addVelocity(_dir, sp);
          s.life = len / sp;
          s.size0 = 0.03;
          s.size1 = 0.012;
          s.color0(C_CYAN_GLOW, 0.6, 1.6).color1(C_CYAN, 0, 1);
          s.fadeIn = 0.3;
          s.fadeOut = 0.2;
          s.stretch = 0.05;
          s.sprite = SPRITE_GLOW;
          fx.glow.spawn(s);
        }
      }
    }

    // release puff around the skirt
    if (st.releasedEvent) {
      st.releasedEvent = false;
      const count = Math.round(22 * Math.max(0.5, q));
      for (let k = 0; k < count; k++) {
        skirtPerimeterPoint(_local, _dir);
        _p.copy(_local).applyMatrix4(car.matrixWorld);
        _dir.applyQuaternion(frame.quaternion);
        const s = _spawn.reset();
        s.setPosition(_p);
        s.setVelocity(v.velocity).addVelocity(_dir, rand(1.5, 3.2)).addVelocity(v.up, -rand(0.3, 1.0));
        s.life = rand(0.55, 0.9);
        s.size0 = rand(0.3, 0.45);
        s.size1 = rand(1.4, 1.9);
        s.sizeEase = 2.2;
        s.color0(C_PUFF, 0.22).color1(C_PUFF, 0);
        s.fadeIn = 0.05;
        s.fadeOut = 0.65;
        s.additive = 0.35;
        s.drag = 0.9; // stays with the car for most of its short life
        if (surface) s.softPlane(_n, _sp, 0.4);
        s.sprite = SPRITE_GLOW;
        fx.smoke.spawn(s);
      }
    }
  });

  return <primitive object={res.root} />;
}

