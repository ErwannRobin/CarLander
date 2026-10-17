/**
 * RcsJets — crisp light-blue cold-gas jets from RCS_PORTS, driven by snapshot.vehicle.rcs
 * (look reference: the blue attitude jets of Tesla's inverted-ramp demo).
 *
 * Port selection: see rcsAllocation.ts (torque-space alignment about the CoM; ports chosen from the
 * command direction, intensity from its magnitude so the stabilizer's gentle corrections show too).
 * Each active port renders a volumetric jet (one draw call for all ports: a convex proxy per port,
 * ray-marched analytic density) with two parts:
 *   - a tight, bright blue-white root right at the port (sampled only where the ray passes it),
 *   - a widening, saturated light-blue body that breaks up into streaks and fades out.
 * Output is premultiplied "emissive + haze": the blue glow (theme-compensated) reads at night, the
 * condensation haze (lit like the smoke) reads against a bright daytime sky.
 * Valves pulse slightly; fast-fading condensation puffs are emitted into the shared smoke pool.
 */
import { useEffect, useMemo } from 'react';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  BackSide,
  FrontSide,
  Group,
  Matrix4,
  Mesh,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
} from 'three';
import { RCS_PORTS } from '@/game/vehicleSpec';
import { PREMULTIPLIED } from '../core/blending';
import { FX_ORDER, type FXFrameContext } from '../core/FXSystem';
import { FOG_FRAG_GLSL, NOISE_GLSL, OUTPUT_FRAG_GLSL } from '../core/glsl';
import { disableRaycast } from '../core/objects';
import { damp, linearColor, linearRGB, rand, randomInCone, randSigned, RateAccumulator } from '../core/math';
import { ParticleSpawn, SPRITE_GLOW } from '../core/ParticlePool';
import { useFX, useFXFrame, useFXReset } from '../FXContext';
import { rcsJetLevels } from './rcsAllocation';
import { useConst } from '../core/useConst';

const PORTS = RCS_PORTS.length;
/** Jet length (m) at full activation. */
const JET_LEN = 2.5;
const BODY_SAMPLES = 14;
const ROOT_SAMPLES = 6;
const C_PUFF = linearRGB('#b9dcff');
/**
 * Jet body gaussian width (m) along the jet: sigma(zn) = SIGMA_BASE + SIGMA_GROW * zn^SIGMA_POW; the
 * convex proxy hull contains it out to HULL_SIGMAS sigma (+ HULL_PAD m). Shared by the shaders and
 * the CPU camera-inside test.
 */
const SIGMA_BASE = 0.03;
const SIGMA_GROW = 0.23;
const SIGMA_POW = 0.8;
const HULL_SIGMAS = 2.6;
const HULL_PAD = 0.03;
/** Camera-near-hull margin (m), larger than the camera near plane (see the inner pass). */
const NEAR_MARGIN = 0.3;
const f = (x: number) => x.toFixed(4);

/** Shared by the vertex (proxy hull) and fragment (field + bounds) shaders. */
const JET_COMMON = /* glsl */ `
// body gaussian width along the jet (zn = 0..1)
float jetSigma(float zn) { return ${f(SIGMA_BASE)} + ${f(SIGMA_GROW)} * pow(zn, ${f(SIGMA_POW)}); }
float proxyRadius(float zn) { return jetSigma(clamp(zn, 0.0, 1.0)) * ${f(HULL_SIGMAS)} + ${f(HULL_PAD)}; }
#define NEAR_MARGIN ${f(NEAR_MARGIN)}
`;

const JET_VERT = /* glsl */ `
attribute vec3 aParam;  // s, theta, radial
attribute vec3 aOrigin; // port position (chassis)
attribute vec4 aDir;    // jet direction (chassis), port index
uniform float uI[${PORTS}];
uniform float uLen;
varying vec3 vPos;
varying vec3 vOrigin;
varying vec3 vDir;
varying float vI;
varying float vL;
varying float vSeed;
${JET_COMMON}
#include <fog_pars_vertex>

void main() {
  float I = uI[int(aDir.w + 0.5)];
  vI = I;
  if (I < 0.01) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // culled: outside the clip volume
    return;
  }
  vec3 d = normalize(aDir.xyz);
  vec3 helper = abs(d.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 u = normalize(cross(helper, d));
  vec3 w = cross(d, u);
  float L = uLen * (0.5 + 0.5 * I);
  float s = aParam.x;
  vec3 p = aOrigin + d * (s * L) + (u * cos(aParam.y) + w * sin(aParam.y)) * (proxyRadius(s) * aParam.z);
  vPos = p;
  vOrigin = aOrigin;
  vDir = d;
  vL = L;
  vSeed = aDir.w * 0.137;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const JET_FRAG = /* glsl */ `
uniform vec3 uCam;
uniform float uTime;
uniform float uEmissive;
uniform vec3 uRoot;
uniform vec3 uJet;
uniform vec3 uHaze;
uniform vec3 uShade;
varying vec3 vPos;
varying vec3 vOrigin;
varying vec3 vDir;
varying float vI;
varying float vL;
varying float vSeed;

${JET_COMMON}
${NOISE_GLSL}
#include <fog_pars_fragment>
${FOG_FRAG_GLSL}

#define ROOT_FRAC 0.16
#define ROOT_R 0.07

/** Widening body: streaky turbulence advected along the jet, breaking up towards the end. */
float bodyField(vec3 q) { // q relative to the port origin
  float z = dot(q, vDir);
  float zn = z / vL;
  if (zn <= 0.0 || zn >= 1.0) return 0.0;
  float r2 = max(dot(q, q) - z * z, 0.0);
  float sg = jetSigma(zn);
  vec3 nq = (vOrigin + q) * 4.2 - vDir * (uTime * 14.0) + vSeed * 31.0;
  float n = fx_noise(nq) * 0.6 + fx_noise(nq * 2.3 + 3.7) * 0.4;
  float turb = mix(1.0, smoothstep(0.22, 0.8, n) * 1.9, smoothstep(0.1, 0.6, zn));
  return pow(1.0 - zn, 1.3) * smoothstep(0.0, 0.05, zn) * sqrt(${f(SIGMA_BASE)} / sg) * turb * exp(-r2 / (sg * sg));
}

/** Tight bright root right at the port. */
float rootField(vec3 q) {
  float z = dot(q, vDir);
  float zn = z / vL;
  if (zn <= 0.0 || zn >= ROOT_FRAC) return 0.0;
  float r2 = max(dot(q, q) - z * z, 0.0);
  float rc = 0.022 + 0.035 * zn / ROOT_FRAC;
  return exp(-r2 / (rc * rc)) * (1.0 - zn / ROOT_FRAC);
}

void main() {
  vec3 ro = uCam - vOrigin;
  vec3 toFrag = vPos - uCam;
  float tFrag = length(toFrag);
  vec3 rd = toFrag / tFrag;

  // jet-local axial / radial decomposition of the ray
  float roz = dot(ro, vDir);
  float rdz = dot(rd, vDir);
  vec3 rop = ro - roz * vDir;
  vec3 rdp = rd - rdz * vDir;
  float a = dot(rdp, rdp);
  float b = dot(rop, rdp);
  float c0 = dot(rop, rop);

  // entry faces integrate forward to the analytic exit; back faces only when the camera is inside
  // (or within a margin of) the hull, so the near plane never clips entry faces into holes
  float sCam = roz / vL;
  bool inside = roz > -NEAR_MARGIN && roz < vL + NEAR_MARGIN && sqrt(c0) < proxyRadius(sCam) + NEAR_MARGIN;
  float t0;
  float t1;
  if (gl_FrontFacing) {
    if (inside) discard;
    t0 = tFrag;
    float rMax = proxyRadius(1.0);
    t1 = 1e5;
    if (a > 1e-6) t1 = (-b + sqrt(max(b * b - a * (c0 - rMax * rMax), 0.0))) / a;
    if (abs(rdz) > 1e-6) t1 = min(t1, max(-roz / rdz, (vL - roz) / rdz));
  } else {
    if (!inside) discard;
    t0 = 0.0;
    t1 = tFrag;
  }
  if (t1 <= t0) discard;
  float j = fx_ign(gl_FragCoord.xy);

  float dt = (t1 - t0) / float(${BODY_SAMPLES});
  float D = 0.0;
  for (int i = 0; i < ${BODY_SAMPLES}; i++) D += bodyField(ro + rd * (t0 + (float(i) + j) * dt));
  D *= dt * vI;

  // root: only where the ray passes within ROOT_R of the axis, inside the root slab
  float C = 0.0;
  float ta = t0;
  float tb = t1;
  bool hit = true;
  if (a > 1e-7) {
    float disc = b * b - a * (c0 - ROOT_R * ROOT_R);
    if (disc <= 0.0) hit = false;
    else {
      float sq = sqrt(disc);
      ta = max(ta, (-b - sq) / a);
      tb = min(tb, (-b + sq) / a);
    }
  } else if (c0 > ROOT_R * ROOT_R) hit = false;
  if (abs(rdz) > 1e-6) {
    float z0 = -roz / rdz;
    float z1 = (vL * ROOT_FRAC - roz) / rdz;
    ta = max(ta, min(z0, z1));
    tb = min(tb, max(z0, z1));
  }
  if (hit && tb > ta) {
    float dc = (tb - ta) / float(${ROOT_SAMPLES});
    for (int i = 0; i < ${ROOT_SAMPLES}; i++) C += rootField(ro + rd * (ta + (float(i) + j) * dc));
    C *= dc * vI * mix(0.35, 1.0, sqrt(a)); // looking down the jet: no blown-out disc
  }

  // emissive blue glow (night) + condensation haze lit like the smoke (day)
  float alpha = (1.0 - exp(-D * 14.0)) * 0.5;
  vec3 col = (uJet * (D * 13.0) + uRoot * (C * 26.0)) * uEmissive + uHaze * uShade * alpha;
  if (alpha < 0.002 && D + C < 1e-4) discard;
  gl_FragColor = vec4(fx_applyFog(col, alpha), alpha);
  ${OUTPUT_FRAG_GLSL}
}
`;

function buildJetGeometry(): BufferGeometry {
  const RINGS = 8;
  const SEG = 14;
  const params: number[] = [];
  const origin: number[] = [];
  const dir: number[] = [];
  const index: number[] = [];
  let base = 0;
  RCS_PORTS.forEach((port, pi) => {
    const push = (s: number, th: number, radial: number) => {
      params.push(s, th, radial);
      origin.push(port.position[0], port.position[1], port.position[2]);
      dir.push(port.dir[0], port.dir[1], port.dir[2], pi);
    };
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
  g.setAttribute('aOrigin', new BufferAttribute(new Float32Array(origin), 3));
  g.setAttribute('aDir', new BufferAttribute(new Float32Array(dir), 4));
  g.setIndex(index);
  return g;
}

function createJetMaterial(intensities: Float32Array): ShaderMaterial {
  return new ShaderMaterial({
    name: 'fx-rcs-jets',
    uniforms: {
      ...UniformsUtils.clone(UniformsLib.fog),
      uI: { value: intensities },
      uLen: { value: JET_LEN },
      uCam: { value: new Vector3() },
      uTime: { value: 0 },
      uEmissive: { value: 1 },
      uRoot: { value: linearColor('#e4f4ff') },
      uJet: { value: linearColor('#4fa8ff') },
      uHaze: { value: linearColor('#d4e9ff') },
      uShade: { value: new Color(1, 1, 1) },
    },
    vertexShader: JET_VERT,
    fragmentShader: JET_FRAG,
    side: FrontSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    fog: true,
    ...PREMULTIPLIED,
  });
}

/**
 * Inner pass: back faces without depth test (the jets start on the bodywork, so their start caps
 * fail the depth test); only visible while the camera is inside / near a jet hull. Shares uniforms.
 */
function createInnerJetMaterial(outer: ShaderMaterial): ShaderMaterial {
  return new ShaderMaterial({
    name: 'fx-rcs-jets-inner',
    uniforms: outer.uniforms,
    vertexShader: JET_VERT,
    fragmentShader: JET_FRAG,
    side: BackSide,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    fog: true,
    ...PREMULTIPLIED,
  });
}

/** CPU version of the shader's proxyRadius (same constants). */
function jetProxyRadiusCPU(zn: number): number {
  const z = Math.min(1, Math.max(0, zn));
  return (SIGMA_BASE + SIGMA_GROW * Math.pow(z, SIGMA_POW)) * HULL_SIGMAS + HULL_PAD;
}

// scratch
const _inv = new Matrix4();
const _cam = new Vector3();
const _portWorld = new Vector3();
const _dirWorld = new Vector3();
const _dir = new Vector3();
const _spawn = new ParticleSpawn();

export function RcsJets() {
  const fx = useFX();
  const res = useMemo(() => {
    const intensities = new Float32Array(PORTS);
    const root = new Group();
    root.name = 'fx-rcs';
    const geometry = buildJetGeometry();
    const material = createJetMaterial(intensities);
    const mesh = disableRaycast(new Mesh(geometry, material));
    mesh.name = 'fx-rcs-jets';
    mesh.frustumCulled = false;
    mesh.renderOrder = FX_ORDER.volumes;
    mesh.visible = false;
    const inner = disableRaycast(new Mesh(geometry, createInnerJetMaterial(material)));
    inner.name = 'fx-rcs-jets-inner';
    inner.frustumCulled = false;
    inner.renderOrder = FX_ORDER.volumes;
    inner.visible = false;
    root.add(mesh, inner);
    return { root, mesh, inner, intensities };
  }, []);

  const st = useConst(() => ({
    /** Allocated activation per port (0..1) and its smoothed visual level. */
    target: new Float32Array(PORTS),
    level: new Float32Array(PORTS),
    puffs: Array.from({ length: PORTS }, () => new RateAccumulator()),
  }));

  useFXReset(() => {
    res.intensities.fill(0);
    st.target.fill(0);
    st.level.fill(0);
    for (let i = 0; i < PORTS; i++) st.puffs[i].reset();
    res.mesh.visible = false;
    res.inner.visible = false;
  });

  useEffect(
    () => () => {
      res.mesh.geometry.dispose();
      res.mesh.material.dispose();
      res.inner.material.dispose();
    },
    [res],
  );

  useFXFrame((ctx: FXFrameContext) => {
    const { frame, snapshot, dt, time } = ctx;
    const v = snapshot.vehicle;
    const { root, mesh, inner, intensities } = res;
    root.position.copy(frame.position);
    root.quaternion.copy(frame.quaternion);
    root.updateMatrixWorld();

    if (!v.crashed) rcsJetLevels(v.rcs.pitch, v.rcs.yaw, v.rcs.roll, st.target);
    else st.target.fill(0);
    // vertical booster: the four underbody ports (jet direction = chassis down) fire together
    if (!v.crashed && v.jumpLevel > 0.02) {
      for (let i = 0; i < PORTS; i++) if (RCS_PORTS[i].dir[1] < -0.5) st.target[i] = Math.max(st.target[i], v.jumpLevel);
    }

    let any = false;
    const level = st.level;
    if (dt > 0) {
      // valves open fast and close a bit slower
      const up = damp(40, dt);
      const down = damp(14, dt);
      for (let i = 0; i < PORTS; i++) {
        // perceptual remap: small commands still show a visible (shorter, fainter) jet
        const t = st.target[i] > 0 ? Math.pow(st.target[i], 0.6) : 0;
        level[i] += (t - level[i]) * (t > level[i] ? up : down);
        if (level[i] < 0.005) level[i] = 0;
      }
    }
    for (let i = 0; i < PORTS; i++) {
      // slight valve pulsing (per-port phase), rendered intensity only
      const pulse = 0.9 + 0.1 * Math.sin(time * 38 + i * 2.3) * Math.sin(time * 11.7 + i);
      intensities[i] = level[i] * pulse;
      if (intensities[i] > 0.01) any = true;
    }
    mesh.visible = any;
    inner.visible = false;
    if (!any) return;

    const u = mesh.material.uniforms;
    ctx.camera.getWorldPosition(_cam);
    _inv.copy(root.matrixWorld).invert();
    _cam.applyMatrix4(_inv);
    (u.uCam.value as Vector3).copy(_cam);
    // inner pass only while the camera is inside / near an active jet hull (same test as the shader)
    for (let i = 0; i < PORTS; i++) {
      if (intensities[i] < 0.01) continue;
      const port = RCS_PORTS[i];
      const L = JET_LEN * (0.5 + 0.5 * intensities[i]);
      const rx = _cam.x - port.position[0];
      const ry = _cam.y - port.position[1];
      const rz = _cam.z - port.position[2];
      const z = rx * port.dir[0] + ry * port.dir[1] + rz * port.dir[2];
      if (z < -NEAR_MARGIN || z > L + NEAR_MARGIN) continue;
      const r = Math.sqrt(Math.max(0, rx * rx + ry * ry + rz * rz - z * z));
      if (r < jetProxyRadiusCPU(z / L) + NEAR_MARGIN) inner.visible = true;
    }
    u.uTime.value = time;
    u.uEmissive.value = ctx.emissive;
    (u.uShade.value as Color).copy(fx.shadeLit).lerp(fx.shadeDark, 0.4);
    // uI shares `intensities` by reference; three uploads uniform arrays every frame.

    if (dt <= 0) return;
    const q = ctx.quality;
    for (let i = 0; i < PORTS; i++) {
      const I = level[i];
      if (I < 0.05) continue;
      const n = st.puffs[i].take(40 * I * q, dt, 6);
      if (n === 0) continue;
      const port = RCS_PORTS[i];
      _portWorld.set(port.position[0], port.position[1], port.position[2]).applyMatrix4(root.matrixWorld);
      _dirWorld.set(port.dir[0], port.dir[1], port.dir[2]).transformDirection(root.matrixWorld);
      const len = JET_LEN * (0.5 + 0.5 * I);
      for (let k = 0; k < n; k++) {
        randomInCone(_dir, _dirWorld, 0.18);
        const s = _spawn.reset();
        s.setPosition(_portWorld).offset(_dirWorld, rand(0.4, 0.95) * len);
        s.setVelocity(v.velocity).addVelocity(_dir, rand(7, 15) * (0.6 + 0.4 * I));
        s.px += randSigned() * 0.06;
        s.py += randSigned() * 0.06;
        s.pz += randSigned() * 0.06;
        s.vx += randSigned() * 1.2;
        s.vy += randSigned() * 1.2;
        s.vz += randSigned() * 1.2;
        s.age = Math.random() * dt;
        // soft glow sprite (lit like smoke): clean condensation puff, no dirty smoke texture
        s.life = rand(0.22, 0.4);
        s.size0 = rand(0.35, 0.5);
        s.size1 = rand(1.6, 2.2) * (0.7 + 0.3 * I);
        s.sizeEase = 2.2;
        s.color0(C_PUFF, 0.1 * (0.5 + 0.5 * I)).color1(C_PUFF, 0);
        s.fadeIn = 0.05;
        s.fadeOut = 0.75;
        s.additive = 0.45;
        s.drag = 6;
        s.sprite = SPRITE_GLOW;
        fx.smoke.spawn(s);
      }
    }
  });

  return <primitive object={res.root} />;
}
