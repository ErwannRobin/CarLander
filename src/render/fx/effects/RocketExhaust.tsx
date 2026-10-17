/**
 * RocketExhaust — main thruster effect for every NOZZLES entry.
 *
 *  - Plume: a convex proxy mesh per nozzle (one draw call for all nozzles) whose fragment shader
 *    integrates an analytic emission field along the view ray:
 *      core   white-hot supersonic jet with diminishing shock (Mach) diamonds. It is a few cm wide,
 *             so its samples are concentrated on the stretch of the ray that passes the jet axis
 *             (crisp from the side, no sampling noise); looking down the axis is softened so the
 *             chase view gets a hot disc rather than a blown-out blob.
 *      sheath turbulent flame envelope: hot yellow -> orange -> deep red, licks advected along the
 *             axis, fading to nothing at the tail.
 *    Length, width and intensity follow boostLevel (plus flicker). Being volumetric, it reads
 *    correctly from any angle, including straight from behind (the chase camera).
 *  - A few hot embers and a thin smoke trail, emitted in world space with sub-frame interpolation
 *    so the trail stays continuous at 80 m/s.
 *  - One shared orange PointLight behind the nozzles (intensity ~ boostLevel, flickering); it also
 *    lights nearby smoke (see FXSystem local lights).
 *  - Ignition flash on 'boostStart', sputter puffs on 'fuelEmpty'.
 */
import { useEffect, useMemo } from 'react';
import {
  BufferAttribute,
  BufferGeometry,
  BackSide,
  FrontSide,
  Group,
  Matrix4,
  Mesh,
  PointLight,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
} from 'three';
import { runtime } from '@/game/runtime';
import type { WheelState } from '@/game/types';
import { NOZZLES } from '@/game/vehicleSpec';
import { PALETTE } from '@/render/palette';
import { PREMULTIPLIED } from '../core/blending';
import { FX_ORDER, type FXFrameContext } from '../core/FXSystem';
import { FOG_FRAG_GLSL, NOISE_GLSL, OUTPUT_FRAG_GLSL } from '../core/glsl';
import { disableRaycast } from '../core/objects';
import {
  damp,
  linearColor,
  linearRGB,
  rand,
  randomInCone,
  randSigned,
  RateAccumulator,
  smoothstep,
  viewAlignment,
} from '../core/math';
import { ParticleSpawn, randomSmokeSprite, SPRITE_GLOW } from '../core/ParticlePool';
import { useFX, useFXFrame, useFXReset } from '../FXContext';
import { useConst } from '../core/useConst';

const NOZZLE_EXIT_Z = 0.02; // plume starts slightly behind the nozzle plane
const MAX_PLUME_LEN = 3.6;
/** Flame length (m) at a given visual boost level. */
const plumeLength = (boost: number) => 1.0 + 2.1 * boost;
/** Ray-march samples: flame sheath (whole chord) and core (stretch of the ray near the jet axis). */
const SHEATH_SAMPLES = 16;
const CORE_SAMPLES = 8;
/** Shock diamonds over the core length. */
const DIAMONDS = 3.2;
/**
 * Flame sheath gaussian width along the plume: sigma(zn) = r0 * (SHEATH_BASE + SHEATH_GROW * zn^SHEATH_POW).
 * The convex proxy hull contains it out to HULL_SIGMAS sigma (+ HULL_PAD m). Shared by the shaders
 * and the CPU camera-inside test.
 */
const SHEATH_BASE = 0.68;
const SHEATH_GROW = 0.95;
const SHEATH_POW = 0.85;
const HULL_SIGMAS = 2.8;
const HULL_PAD = 0.04;
/** Camera-near-hull margin (m), larger than the camera near plane (see the inner pass). */
const NEAR_MARGIN = 0.3;
const f = (x: number) => x.toFixed(4);

const C_CORE = linearRGB(PALETTE.orangeCore);
const C_HOT = linearRGB(PALETTE.orangeHot);
const C_ORANGE = linearRGB(PALETTE.orange);
const C_SMOKE = linearRGB('#d3d0cb');
const C_SOOT = linearRGB('#5d5a57');

/** Shared by the vertex (proxy hull) and fragment (field + bounds) shaders. */
const PLUME_COMMON = /* glsl */ `
uniform float uLen;
uniform float uR0;
// flame sheath gaussian width along the plume (zn = 0..1)
float sheathSigma(float zn) { return uR0 * (${f(SHEATH_BASE)} + ${f(SHEATH_GROW)} * pow(zn, ${f(SHEATH_POW)})); }
// convex proxy radius: contains the sheath out to HULL_SIGMAS sigma
float proxyRadius(float zn) { return sheathSigma(clamp(zn, 0.0, 1.0)) * ${f(HULL_SIGMAS)} + ${f(HULL_PAD)}; }
#define NEAR_MARGIN ${f(NEAR_MARGIN)}
`;

const PLUME_VERT = /* glsl */ `
attribute vec3 aParam;   // s (0..1 along), theta, radial (0 = cap center, 1 = rim)
attribute vec4 aNozzle;  // nozzle exit center (chassis local), seed
varying vec3 vPos;
varying vec4 vNozzle;
${PLUME_COMMON}
#include <fog_pars_vertex>
void main() {
  float s = aParam.x;
  float R = proxyRadius(s);
  vec3 p = aNozzle.xyz + vec3(cos(aParam.y) * R * aParam.z, sin(aParam.y) * R * aParam.z, s * uLen);
  vPos = p;
  vNozzle = aNozzle;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const PLUME_FRAG = /* glsl */ `
uniform vec3 uCam;        // camera position, chassis local
uniform float uCoreLen;
uniform float uTime;
uniform float uBoost;
uniform vec3 uCore;
uniform vec3 uHot;
uniform vec3 uOrange;
uniform vec3 uRed;
varying vec3 vPos;
varying vec4 vNozzle;

${PLUME_COMMON}
${NOISE_GLSL}
#include <fog_pars_fragment>
${FOG_FRAG_GLSL}

// Max radius of the core (column + diamonds): bounds the core sampling window.
#define CORE_R (uR0 * 0.7)

/**
 * Supersonic core: x = continuous, slowly narrowing jet column (hot yellow), y = rhombus-shaped
 * shock diamonds inside it (white), fading one after the other.
 */
vec2 coreField(vec3 p) {
  float zc = p.z / uCoreLen;
  if (zc <= 0.0 || zc >= 1.0) return vec2(0.0);
  float r = length(p.xy);
  float rj = uR0 * mix(0.52, 0.27, zc);
  float column = exp(-(r * r) / (rj * rj));
  float ph = zc * ${DIAMONDS.toFixed(2)} + 0.05 * sin(uTime * 41.0);
  float cell = fract(ph);
  float k = floor(ph);
  // rhombus in the (axial, radial) plane: pointed along the axis, widest mid-cell
  float d = abs(2.0 * cell - 1.0) + r / (rj * 0.9);
  float dia = (1.0 - smoothstep(0.3, 1.0, d)) * pow(0.6, k);
  return vec2(column * 0.42, dia * 1.6) * (pow(1.0 - zc, 1.1) * smoothstep(0.0, 0.04, zc));
}

/** Turbulent flame envelope: rgb = emitted color, a = density (for the slight occlusion). */
vec4 sheathField(vec3 p) {
  float zn = p.z / uLen;
  if (zn <= 0.0 || zn >= 1.0) return vec4(0.0);
  float r2 = dot(p.xy, p.xy);
  float s = sheathSigma(zn);
  // streaky turbulence: stretched along the axis, advected fast
  vec3 q = vec3(p.xy * 7.5, p.z * 1.6 - uTime * 23.0) + vNozzle.w * 17.0;
  float n = fx_noise(q) * 0.62 + fx_noise(q * 2.31 + vec3(4.1, 1.7, 2.9)) * 0.38;
  // tongues of flame: the tail breaks up into licks, the root stays solid
  float licks = mix(1.0, smoothstep(0.3, 0.78, n) * 2.1, smoothstep(0.08, 0.5, zn));
  float I = smoothstep(0.0, 0.05, zn) * pow(1.0 - zn, 2.0) * licks * (uR0 / s);
  vec3 col = mix(uHot, uOrange, smoothstep(0.03, 0.38, zn));
  col = mix(col, uRed, smoothstep(0.45, 1.0, zn));
  float D = I * exp(-r2 / (s * s));
  return vec4(col * D, D);
}

void main() {
  vec3 ro = uCam - vNozzle.xyz;
  vec3 toFrag = vPos - uCam;
  float tFrag = length(toFrag);
  vec3 rd = toFrag / tFrag;
  float a = dot(rd.xy, rd.xy);   // sin^2 of the angle between the ray and the jet axis
  float b = dot(ro.xy, rd.xy);
  float roR2 = dot(ro.xy, ro.xy);

  // Entry faces are integrated forward to the analytic exit (robust when the exit surface is
  // hidden by the ground); back faces are only used when the camera is inside the volume — or
  // close enough to it that the near plane could clip the entry faces (hard-edged holes), so the
  // test uses a margin (the field is analytic: integrating from the camera is exact).
  float sCam = ro.z / uLen;
  bool inside = ro.z > -NEAR_MARGIN && ro.z < uLen + NEAR_MARGIN && sqrt(roR2) < proxyRadius(sCam) + NEAR_MARGIN;
  float t0;
  float t1;
  if (gl_FrontFacing) {
    if (inside) discard;
    t0 = tFrag;
    float rMax = proxyRadius(1.0);
    t1 = 1e5;
    if (a > 1e-6) t1 = (-b + sqrt(max(b * b - a * (roR2 - rMax * rMax), 0.0))) / a;
    if (abs(rd.z) > 1e-6) t1 = min(t1, max(-ro.z / rd.z, (uLen - ro.z) / rd.z));
  } else {
    if (!inside) discard;
    t0 = 0.0;
    t1 = tFrag;
  }
  if (t1 <= t0) discard;
  float j = fx_ign(gl_FragCoord.xy);

  // flame sheath: uniform jittered samples over the chord
  float dt = (t1 - t0) / float(${SHEATH_SAMPLES});
  vec4 sh = vec4(0.0);
  for (int i = 0; i < ${SHEATH_SAMPLES}; i++) sh += sheathField(ro + rd * (t0 + (float(i) + j) * dt));
  // view-angle normalization: from the side the flame is thin (boost it so it reads in daylight),
  // seen along the axis it would integrate its whole length into a wide glare (tame it)
  float side = sqrt(a);
  sh *= dt * 26.0 * mix(0.3, 1.0, side);
  vec3 acc = sh.rgb;
  float density = sh.a;

  // core: integrate only where the ray is within CORE_R of the axis and inside the core slab
  float ta = t0;
  float tb = t1;
  bool hit = true;
  if (a > 1e-7) {
    float disc = b * b - a * (roR2 - CORE_R * CORE_R);
    if (disc <= 0.0) hit = false;
    else {
      float sq = sqrt(disc);
      ta = max(ta, (-b - sq) / a);
      tb = min(tb, (-b + sq) / a);
    }
  } else if (roR2 > CORE_R * CORE_R) hit = false;
  if (abs(rd.z) > 1e-6) {
    float z0 = -ro.z / rd.z;
    float z1 = (uCoreLen - ro.z) / rd.z;
    ta = max(ta, min(z0, z1));
    tb = min(tb, max(z0, z1));
  } else if (ro.z < 0.0 || ro.z > uCoreLen) hit = false;
  if (hit && tb > ta) {
    float dc = (tb - ta) / float(${CORE_SAMPLES});
    vec2 core = vec2(0.0);
    for (int i = 0; i < ${CORE_SAMPLES}; i++) core += coreField(ro + rd * (ta + (float(i) + j) * dc));
    // looking down the axis would accumulate the whole column: soften it (optically thick look)
    core *= dc * 52.0 * mix(0.28, 1.0, side);
    acc += mix(uCore, uHot, 0.45) * core.x + uCore * core.y;
    density += (core.x + core.y) * 0.5;
  }
  acc *= uBoost;
  // Mostly emissive; a little occlusion (premultiplied alpha) keeps the flame saturated and
  // legible in front of a bright daytime sky. Invisible at night (dark background).
  float alpha = (1.0 - exp(-density * uBoost * 0.07)) * 0.6;
  gl_FragColor = vec4(fx_applyFog(acc, alpha), alpha);
  ${OUTPUT_FRAG_GLSL}
}
`;

/** Convex proxy (bullet-shaped closed surface of revolution) per nozzle, parametric in the shader. */
function buildPlumeGeometry(): BufferGeometry {
  const RINGS = 10;
  const SEG = 20;
  const params: number[] = [];
  const nozzle: number[] = [];
  const index: number[] = [];
  let base = 0;
  NOZZLES.forEach((nz, ni) => {
    const cx = nz.position[0];
    const cy = nz.position[1];
    const cz = nz.position[2] + NOZZLE_EXIT_Z;
    const seed = ni * 0.37 + 0.11;
    const push = (s: number, th: number, radial: number) => {
      params.push(s, th, radial);
      nozzle.push(cx, cy, cz, seed);
    };
    // side rings (outward-facing)
    for (let r = 0; r <= RINGS; r++) {
      const s = r / RINGS;
      for (let k = 0; k <= SEG; k++) push(s, (k / SEG) * Math.PI * 2, 1);
    }
    for (let r = 0; r < RINGS; r++) {
      for (let k = 0; k < SEG; k++) {
        const a = base + r * (SEG + 1) + k;
        const b = a + SEG + 1;
        // outward-facing winding: front faces = entry surface (see the fragment shader)
        index.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    base += (RINGS + 1) * (SEG + 1);
    // caps (center + rim)
    for (const s of [0, 1]) {
      const center = base;
      push(s, 0, 0);
      for (let k = 0; k <= SEG; k++) push(s, (k / SEG) * Math.PI * 2, 1);
      for (let k = 0; k < SEG; k++) {
        if (s === 0) index.push(center, center + 1 + k + 1, center + 1 + k);
        else index.push(center, center + 1 + k, center + 1 + k + 1);
      }
      base += SEG + 2;
    }
  });
  const g = new BufferGeometry();
  const count = params.length / 3;
  g.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3));
  g.setAttribute('aParam', new BufferAttribute(new Float32Array(params), 3));
  g.setAttribute('aNozzle', new BufferAttribute(new Float32Array(nozzle), 4));
  g.setIndex(index);
  return g;
}

/**
 * Outer pass (front faces, depth-tested) and inner pass (back faces, no depth test — the exit
 * surface lies on the car's tail and would fail the depth test; only visible while the camera is
 * inside / near a plume, see RocketExhaust). Both share one uniforms object.
 */
function createPlumeMaterials(): { outer: ShaderMaterial; inner: ShaderMaterial } {
  const outer = createPlumeMaterial();
  const inner = new ShaderMaterial({
    name: 'fx-rocket-plume-inner',
    uniforms: outer.uniforms,
    vertexShader: PLUME_VERT,
    fragmentShader: PLUME_FRAG,
    side: BackSide,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    ...PREMULTIPLIED,
    fog: true,
  });
  return { outer, inner };
}

function createPlumeMaterial(): ShaderMaterial {
  const r0 = NOZZLES[0]?.radius ?? 0.13;
  return new ShaderMaterial({
    name: 'fx-rocket-plume',
    uniforms: {
      ...UniformsUtils.clone(UniformsLib.fog),
      uCam: { value: new Vector3() },
      uLen: { value: 2 },
      uCoreLen: { value: 0.6 },
      uR0: { value: r0 },
      uTime: { value: 0 },
      uBoost: { value: 0 },
      uCore: { value: linearColor(PALETTE.orangeCore) },
      uHot: { value: linearColor(PALETTE.orangeHot) },
      uOrange: { value: linearColor(PALETTE.orange) },
      uRed: { value: linearColor('#c2300c', 0.8) },
    },
    vertexShader: PLUME_VERT,
    fragmentShader: PLUME_FRAG,
    side: FrontSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    ...PREMULTIPLIED,
    fog: true,
  });
}

/** CPU version of the shader's proxyRadius (same constants). */
function proxyRadiusCPU(r0: number, zn: number): number {
  const z = Math.min(1, Math.max(0, zn));
  return r0 * (SHEATH_BASE + SHEATH_GROW * Math.pow(z, SHEATH_POW)) * HULL_SIGMAS + HULL_PAD;
}

// scratch
const _inv = new Matrix4();
const _camWorld = new Vector3();
const _exhaustDir = new Vector3();
const _nozzleWorld = new Vector3();
const _p = new Vector3();
const _dir = new Vector3();
const _centroid = new Vector3();
const _up = new Vector3();
const _spawn = new ParticleSpawn();

const SPUTTER_TIMES = [0, 0.12, 0.27, 0.48, 0.72] as const;
/** Exhaust light: chassis-local height and peak intensity (candela) at full boost. */
const LIGHT_HEIGHT = 0.45;
const LIGHT_INTENSITY = 6;
/** Smoke trail: one puff per this many meters of nozzle travel (at quality 1). */
const TRAIL_SPACING = 0.3;
/**
 * Trail opacity kept when the camera looks straight along the exhaust axis (chase view). Seen
 * end-on, dozens of puffs overlap on every pixel while the ones nearest the camera resolve into a
 * string of separate blobs; side / quarter views keep the full trail.
 */
const TRAIL_END_ON = 0.2;
/** Approximate length of the vapor trail behind the car at speed (m). */
const TRAIL_LENGTH = 20;

export function RocketExhaust() {
  const fx = useFX();
  const res = useMemo(() => {
    const root = new Group();
    root.name = 'fx-rocket-exhaust';
    const geometry = buildPlumeGeometry();
    const mats = createPlumeMaterials();
    const plume = disableRaycast(new Mesh(geometry, mats.outer));
    plume.name = 'fx-rocket-plume';
    plume.frustumCulled = false;
    plume.renderOrder = FX_ORDER.volumes;
    plume.visible = false;
    const plumeInner = disableRaycast(new Mesh(geometry, mats.inner));
    plumeInner.name = 'fx-rocket-plume-inner';
    plumeInner.frustumCulled = false;
    plumeInner.renderOrder = FX_ORDER.volumes;
    plumeInner.visible = false;
    root.add(plume, plumeInner);
    // Stays in the scene with intensity 0 when idle (light count changes recompile lit materials).
    const light = new PointLight(PALETTE.orange, 0, 12, 2);
    light.name = 'fx-exhaust-light';
    light.castShadow = false;
    // Behind the nozzles and ~0.8 m above the ground at rest: lights the ground / surroundings more
    // than the bodywork, without the inverse-square hot spot a light hugging the ground would burn
    // into the asphalt at night.
    light.position.set(0, LIGHT_HEIGHT, (NOZZLES[0]?.position[2] ?? 2.2) + 1.25);
    root.add(light);
    return { root, plume, plumeInner, light };
  }, []);

  const st = useConst(() => ({
    prev: NOZZLES.map(() => new Vector3()),
    hasPrev: false,
    embers: NOZZLES.map(() => new RateAccumulator()),
    smoke: NOZZLES.map(() => new RateAccumulator()),
    boost: 0,
    /** Random part of the flame flicker, re-rolled only while the FX clock runs (frozen when paused). */
    flickerNoise: 0,
    /** Index of the next sputter pop (>= SPUTTER_TIMES.length: idle) and FX time of 'fuelEmpty'. */
    sputterNext: SPUTTER_TIMES.length as number,
    sputterStart: 0,
    ignitionPending: false,
  }));

  // the exhaust light also lights nearby smoke (FX local lights)
  useEffect(() => fx.registerLight(res.light), [fx, res]);

  useEffect(() => {
    const offStart = runtime.events.on('boostStart', () => {
      st.ignitionPending = true;
    });
    const offFuel = runtime.events.on('fuelEmpty', () => {
      st.sputterNext = 0;
      st.sputterStart = fx.time;
    });
    return () => {
      offStart();
      offFuel();
    };
  }, [fx, st]);

  useFXReset(() => {
    st.hasPrev = false;
    st.boost = 0;
    st.sputterNext = SPUTTER_TIMES.length;
    st.ignitionPending = false;
    res.plume.visible = false;
    res.plumeInner.visible = false;
    res.light.intensity = 0;
    for (let i = 0; i < NOZZLES.length; i++) {
      st.embers[i].reset();
      st.smoke[i].reset();
    }
  });

  useEffect(
    () => () => {
      res.plume.geometry.dispose();
      res.plume.material.dispose();
      res.plumeInner.material.dispose();
      res.light.dispose();
    },
    [res],
  );

  useFXFrame((ctx: FXFrameContext) => {
    const { frame, snapshot, dt, time } = ctx;
    const v = snapshot.vehicle;
    const { root, plume, plumeInner, light } = res;
    root.position.copy(frame.position);
    root.quaternion.copy(frame.quaternion);
    root.updateMatrixWorld();

    // visual boost level: snappy attack, smooth release (v.boostLevel is already smoothed by the sim)
    const target = v.boostLevel;
    if (dt > 0) st.boost += (target - st.boost) * damp(target > st.boost ? 30 : 9, dt);
    const boost = st.boost;
    if (dt > 0) st.flickerNoise = randSigned();
    const flicker = 0.9 + 0.06 * Math.sin(time * 61.0) + 0.04 * Math.sin(time * 37.3 + 1.7) + 0.03 * st.flickerNoise;

    _exhaustDir.set(0, 0, 1).applyQuaternion(frame.quaternion);
    const speed = v.speed;

    // --- plume uniforms ---
    const u = plume.material.uniforms;
    plume.visible = boost > 0.01;
    plumeInner.visible = false;
    if (plume.visible) {
      camWorldToLocal(ctx, root.matrixWorld);
      (u.uCam.value as Vector3).copy(_camWorld);
      const len = Math.min(MAX_PLUME_LEN, plumeLength(boost) * (0.93 + 0.07 * flicker) * (1 + Math.min(speed, 80) / 400));
      u.uLen.value = len;
      // inner pass only while the camera is inside / near a plume hull (same test as the shader)
      const r0 = u.uR0.value as number;
      for (let i = 0; i < NOZZLES.length; i++) {
        const nz = NOZZLES[i].position;
        const dz = _camWorld.z - (nz[2] + NOZZLE_EXIT_Z);
        if (dz < -NEAR_MARGIN || dz > len + NEAR_MARGIN) continue;
        const r = Math.hypot(_camWorld.x - nz[0], _camWorld.y - nz[1]);
        if (r < proxyRadiusCPU(r0, dz / len) + NEAR_MARGIN) plumeInner.visible = true;
      }
      u.uCoreLen.value = (0.45 + 0.5 * boost) * (0.96 + 0.04 * flicker);
      u.uTime.value = time;
      u.uBoost.value = Math.min(1, boost * 1.15) * flicker * ctx.emissive;
    }

    // --- light ---
    light.intensity = boost * LIGHT_INTENSITY * flicker * ctx.emissive;

    // --- particles (world space, interpolated along the nozzle path for continuous trails) ---
    const q = ctx.quality;
    let groundWheel: WheelState | null = null;
    for (let w = 0; w < v.wheels.length; w++) if (v.wheels[w].grounded) groundWheel = v.wheels[w];
    for (let i = 0; i < NOZZLES.length; i++) {
      const nz = NOZZLES[i];
      _nozzleWorld.set(nz.position[0], nz.position[1], nz.position[2] + NOZZLE_EXIT_Z).applyMatrix4(root.matrixWorld);
      const prev = st.prev[i];
      const moved = st.hasPrev ? prev.distanceTo(_nozzleWorld) : 0;
      if (!st.hasPrev || moved > Math.max(8, speed * dt * 4 + 2)) prev.copy(_nozzleWorld); // teleport
      if (boost > 0.03 && dt > 0) {
        emitEmbers(ctx, i, prev, boost * q);
        const view = 1 - (1 - TRAIL_END_ON) * smoothstep(0.7, 0.97, viewAlignment(ctx.camera, _nozzleWorld, _exhaustDir));
        emitTrail(ctx, i, prev, boost, q, groundWheel, prev.distanceTo(_nozzleWorld), view);
      }
      prev.copy(_nozzleWorld);
    }
    st.hasPrev = true;

    if (st.ignitionPending && dt > 0) {
      st.ignitionPending = false;
      ignition(ctx, root.matrixWorld);
    }
    if (st.sputterNext < SPUTTER_TIMES.length && dt > 0) {
      const elapsed = time - st.sputterStart;
      while (st.sputterNext < SPUTTER_TIMES.length && elapsed >= SPUTTER_TIMES[st.sputterNext]) {
        sputterPop(ctx, root.matrixWorld, 1 - st.sputterNext / SPUTTER_TIMES.length);
        st.sputterNext++;
      }
    }
  });

  /** Hot embers from nozzle `i` (current position in _nozzleWorld, previous in `prev`). */
  function emitEmbers(ctx: FXFrameContext, i: number, prev: Vector3, rateScale: number) {
    const { dt } = ctx;
    const v = ctx.snapshot.vehicle;
    // sparse and short-lived: hot specks zipping out of the plume, gone within a few meters
    const n = st.embers[i].take(24 * rateScale, dt, 6);
    for (let k = 0; k < n; k++) {
      const f = (k + Math.random()) / n;
      _p.lerpVectors(prev, _nozzleWorld, f).addScaledVector(_exhaustDir, rand(0.1, 0.6));
      randomInCone(_dir, _exhaustDir, 0.1);
      const s = _spawn.reset();
      s.setPosition(_p);
      s.setVelocity(v.velocity).addVelocity(_dir, rand(18, 34));
      s.vy += rand(-0.3, 0.8);
      s.age = (1 - f) * dt;
      s.life = rand(0.12, 0.3);
      s.size0 = rand(0.03, 0.05);
      s.size1 = 0.012;
      s.color0(C_HOT, 1, 5).color1(C_ORANGE, 0, 2.4);
      s.colorPow = 0.55;
      s.fadeOut = 0.45;
      s.stretch = 0.007;
      s.drag = 4;
      s.gravity = 0.2;
      s.sprite = SPRITE_GLOW;
      fx.glow.spawn(s);
    }
  }

  /**
   * Thin smoke trail released from the plume tail of nozzle `i`. Emitted by distance travelled
   * (one puff every TRAIL_SPACING m, quality-scaled) so it stays a continuous ribbon at 80 m/s
   * instead of breaking into separate puffs; `travel` = nozzle displacement this frame (m),
   * `view` = opacity factor for the current viewing angle (thinner when seen end-on).
   */
  function emitTrail(
    ctx: FXFrameContext,
    i: number,
    prev: Vector3,
    boost: number,
    q: number,
    ground: WheelState | null,
    travel: number,
    view: number,
  ) {
    const { dt } = ctx;
    const v = ctx.snapshot.vehicle;
    const tail = plumeLength(boost) * 0.85;
    const spacing = TRAIL_SPACING / Math.max(0.4, q);
    const rate = Math.max(16, travel / dt / spacing) * Math.min(1, boost * 1.6);
    const n = st.smoke[i].take(rate, dt, 12);
    for (let k = 0; k < n; k++) {
      const f = (k + Math.random()) / n;
      _p.lerpVectors(prev, _nozzleWorld, f).addScaledVector(_exhaustDir, tail * rand(0.85, 1.1));
      const s = _spawn.reset();
      s.setPosition(_p);
      s.px += randSigned() * 0.06;
      s.py += randSigned() * 0.06;
      s.pz += randSigned() * 0.06;
      // left behind in world space: barely inherits the car velocity (little random drift, so the
      // overlapping puffs stay an even ribbon rather than a lumpy one)
      s.setVelocity(v.velocity, 0.12).addVelocity(_exhaustDir, rand(3.5, 5.5));
      s.vx += randSigned() * 0.25;
      s.vy += rand(0.15, 0.45);
      s.vz += randSigned() * 0.25;
      s.age = (1 - f) * dt;
      // roughly constant trail length (≈ 20–27 m behind the car from 20 to 80 m/s) instead of a
      // constant lifetime, whose trail would grow with speed and pile up in front of the chase camera
      s.life = Math.min(1.0, Math.max(0.38, TRAIL_LENGTH / Math.max(v.speed, 1))) * rand(0.85, 1.15);
      s.size0 = rand(0.3, 0.42);
      s.size1 = rand(1.2, 1.7);
      s.sizeEase = 2.4;
      // soft round (lit) sprite: overlapping puffs merge into a smooth vapor ribbon
      s.color0(C_SMOKE, 0.12 * (0.5 + 0.5 * boost) * view).color1(C_SMOKE, 0.0);
      s.fadeIn = 0.22;
      s.fadeOut = 0.6;
      s.drag = 2;
      s.gravity = -0.03;
      if (ground) s.softPlane(ground.contactNormal, ground.contactPoint, 0.5);
      s.sprite = SPRITE_GLOW;
      fx.smoke.spawn(s);
    }
  }

  /** Big bright flash + ember spray + smoke ring at every nozzle. */
  function ignition(ctx: FXFrameContext, world: Matrix4) {
    const v = ctx.snapshot.vehicle;
    _centroid.set(0, 0, 0);
    for (let i = 0; i < NOZZLES.length; i++) {
      const nz = NOZZLES[i];
      _nozzleWorld.set(nz.position[0], nz.position[1], nz.position[2] + NOZZLE_EXIT_Z).applyMatrix4(world);
      _centroid.add(_nozzleWorld);
      // flash sprite
      let s = _spawn.reset();
      s.setPosition(_nozzleWorld).offset(_exhaustDir, 0.25);
      s.setVelocity(v.velocity);
      s.life = 0.16;
      s.size0 = 0.5;
      s.size1 = 1.7;
      s.sizeEase = 2;
      s.color0(C_CORE, 1, 6).color1(C_HOT, 0, 3);
      s.fadeOut = 0.7;
      s.sprite = SPRITE_GLOW;
      fx.glow.spawn(s);
      // embers
      const ne = Math.round(8 * ctx.quality + 3);
      for (let k = 0; k < ne; k++) {
        randomInCone(_dir, _exhaustDir, 0.42);
        s = _spawn.reset();
        s.setPosition(_nozzleWorld);
        s.setVelocity(v.velocity, 0.9).addVelocity(_dir, rand(6, 16));
        s.life = rand(0.18, 0.42);
        s.size0 = rand(0.035, 0.06);
        s.size1 = 0.012;
        s.color0(C_HOT, 1, 4).color1(C_ORANGE, 0, 2);
        s.colorPow = 0.5;
        s.stretch = 0.016;
        s.drag = 3;
        s.gravity = 0.4;
        fx.glow.spawn(s);
      }
      // smoke ring (perpendicular to the exhaust axis)
      const nr = Math.round(8 * ctx.quality + 3);
      for (let k = 0; k < nr; k++) {
        randomInCone(_dir, _exhaustDir, Math.PI / 2);
        _dir.addScaledVector(_exhaustDir, -_dir.dot(_exhaustDir)).normalize();
        s = _spawn.reset();
        s.setPosition(_nozzleWorld).offset(_exhaustDir, 0.3);
        s.setVelocity(v.velocity, 0.6).addVelocity(_dir, rand(2, 4)).addVelocity(_exhaustDir, rand(3, 6));
        s.life = rand(0.7, 1.1);
        s.size0 = 0.3;
        s.size1 = rand(1.2, 1.7);
        s.sizeEase = 2.2;
        s.color0(C_SMOKE, 0.28).color1(C_SMOKE, 0);
        s.fadeIn = 0.06;
        s.fadeOut = 0.6;
        s.drag = 2.6;
        s.rot = Math.random() * 6.28;
        s.rotSpeed = randSigned();
        s.sprite = randomSmokeSprite();
        fx.smoke.spawn(s);
      }
    }
    // lifted above the nozzles: a light hugging the ground burns a hot spot into it
    _centroid.multiplyScalar(1 / Math.max(1, NOZZLES.length)).addScaledVector(_exhaustDir, 0.8);
    _centroid.addScaledVector(_up.set(0, 1, 0).applyQuaternion(ctx.frame.quaternion), 0.6);
    fx.flash(_centroid, C_HOT, 30, 0.2);
  }

  /** One sputter pop: dark puff + small orange flash per nozzle. */
  function sputterPop(ctx: FXFrameContext, world: Matrix4, strength: number) {
    const v = ctx.snapshot.vehicle;
    for (let i = 0; i < NOZZLES.length; i++) {
      const nz = NOZZLES[i];
      _nozzleWorld.set(nz.position[0], nz.position[1], nz.position[2] + NOZZLE_EXIT_Z).applyMatrix4(world);
      let s = _spawn.reset();
      s.setPosition(_nozzleWorld).offset(_exhaustDir, 0.12);
      s.setVelocity(v.velocity);
      s.life = 0.08;
      s.size0 = 0.2;
      s.size1 = 0.55 * (0.6 + 0.4 * strength);
      s.color0(C_HOT, 1, 4).color1(C_ORANGE, 0, 2);
      fx.glow.spawn(s);
      // a soft, dark cough of unburnt propellant per pop: round blobs that bloom out of the nozzle
      // and thin into grey haze (several faint puffs rather than one opaque "popcorn" ball)
      for (let k = 0; k < 3; k++) {
        s = _spawn.reset();
        s.setPosition(_nozzleWorld).offset(_exhaustDir, 0.2 + 0.15 * k);
        s.setVelocity(v.velocity, 0.75).addVelocity(_exhaustDir, rand(2.5, 6));
        s.vx += randSigned() * 0.8;
        s.vy += rand(0.2, 1.0);
        s.vz += randSigned() * 0.8;
        s.life = rand(0.8, 1.3);
        s.size0 = rand(0.15, 0.25);
        s.size1 = rand(0.9, 1.3) * (0.6 + 0.4 * strength);
        s.sizeEase = 2.2;
        s.color0(C_SOOT, 0.28 * (0.5 + 0.5 * strength)).color1(C_SMOKE, 0);
        s.fadeIn = 0.04;
        s.fadeOut = 0.65;
        s.drag = 2.2;
        s.gravity = -0.03;
        s.rot = Math.random() * 6.28;
        s.rotSpeed = randSigned();
        s.blob = 1;
        s.sprite = randomSmokeSprite();
        fx.smoke.spawn(s);
      }
    }
    _centroid.set(0, 0, (NOZZLES[0]?.position[2] ?? 2.2) + 0.5).applyMatrix4(world);
    fx.flash(_centroid, C_ORANGE, 12 * strength + 4, 0.09);
  }

  return <primitive object={res.root} />;
}

/** Camera world position -> chassis-local space (into _camWorld). */
function camWorldToLocal(ctx: FXFrameContext, world: Matrix4): void {
  ctx.camera.getWorldPosition(_camWorld);
  _inv.copy(world).invert();
  _camWorld.applyMatrix4(_inv);
}
