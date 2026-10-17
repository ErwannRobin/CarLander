/**
 * RingWavePool — instanced, surface-aligned transient decals (one draw call):
 *  - 'shock' : soft, dusty expanding shockwave band (landings, slams)
 *  - 'ring'  : crisp energy ring with a faint halo (perfect landing, vacuum pulse)
 *  - 'flash' : soft radial disc that blooms and fades (contact flashes)
 *
 * All animation runs in the shader from per-instance start time / life, so spawning only writes
 * one instance record (ring buffer, oldest replaced). Time is the FX (sim-scaled) clock.
 */
import {
  BufferAttribute,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  Quaternion,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
} from 'three';
import { PREMULTIPLIED } from './blending';
import { FOG_FRAG_GLSL, NOISE_GLSL, OUTPUT_FRAG_GLSL, QUAT_GLSL } from './glsl';
import { disableRaycast } from './objects';
import type { RGB } from './math';

export type RingKind = 'shock' | 'ring' | 'flash';
const KIND_ID: Record<RingKind, number> = { shock: 0, ring: 1, flash: 2 };

/** Reusable spawn description (keep one at module scope, `reset()` and fill). */
export class RingSpawn {
  readonly center = new Vector3();
  readonly normal = new Vector3(0, 1, 0);
  kind: RingKind = 'ring';
  /** Start / end radius (m). */
  r0 = 0.5;
  r1 = 4;
  life = 0.6;
  /** Seconds before the ring appears. */
  delay = 0;
  /** Band half-width (m). */
  thickness = 0.1;
  alpha = 1;
  /** Linear RGB (may be HDR). */
  color: RGB = [1, 1, 1];
  /** 0 = alpha "over", 1 = additive. */
  additive = 1;
  /** Lift along the normal to avoid z-fighting (m). */
  lift = 0.03;

  reset(): this {
    this.center.set(0, 0, 0);
    this.normal.set(0, 1, 0);
    this.kind = 'ring';
    this.r0 = 0.5;
    this.r1 = 4;
    this.life = 0.6;
    this.delay = 0;
    this.thickness = 0.1;
    this.alpha = 1;
    this.color = [1, 1, 1];
    this.additive = 1;
    this.lift = 0.03;
    return this;
  }
}

const VERT = /* glsl */ `
attribute vec3 iCenter;
attribute vec4 iQuat;
attribute vec4 iTiming;  // start, life, r0, r1
attribute vec4 iStyle;   // thickness, alpha, kind, additive
attribute vec3 iColor;

uniform float uTime;

varying vec2 vLocal;
varying float vT;
varying float vR;
varying vec4 vStyle;
varying vec3 vColor;
varying float vSeed;

${QUAT_GLSL}
#include <fog_pars_vertex>

void main() {
  float t = (uTime - iTiming.x) / iTiming.y;
  if (t < 0.0 || t > 1.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // outside the clip volume
    return;
  }
  float e = 1.0 - pow(1.0 - t, 2.6);
  float R = mix(iTiming.z, iTiming.w, e);
  // quad half-size must contain the band / halo (shock & ring) or the disc falloff (flash)
  float ext = iStyle.z < 1.5 ? R + iStyle.x * 16.0 + 0.3 : R * 1.7 + 0.3;
  vec3 local = vec3(position.xy * 2.0 * ext, 0.0);
  vec3 world = iCenter + fx_rotate(iQuat, local);
  vLocal = local.xy;
  vT = t;
  vR = R;
  vStyle = iStyle;
  vColor = iColor;
  vSeed = fract(dot(iCenter, vec3(0.1031, 0.1030, 0.0973)) * 43.7);
  vec4 mvPosition = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
varying vec2 vLocal;
varying float vT;
varying float vR;
varying vec4 vStyle;
varying vec3 vColor;
varying float vSeed;

uniform vec3 uDustTint;
uniform float uEmissive;

${NOISE_GLSL}
#include <fog_pars_fragment>
${FOG_FRAG_GLSL}

void main() {
  float d = length(vLocal);
  float w = vStyle.x;
  float kind = vStyle.z;
  float aa = fwidth(d);
  float a;
  if (kind < 0.5) {
    // dusty shockwave: soft band (sharper leading edge) that thickens as it travels, broken up
    // by noise; fades fast so it reads as a pulse, not a sheet on the ground
    float ww = max(w * (1.0 + vT * 1.2), aa);
    float x = (d - vR) / ww;
    float band = x > 0.0 ? exp(-x * x * 4.0) : exp(-x * x * 0.9);
    float ang = atan(vLocal.y, vLocal.x);
    float n = fx_fbm3(vec3(cos(ang) * 2.5 + vSeed * 9.0, sin(ang) * 2.5, d * 0.35));
    a = band * (0.35 + 0.9 * n) * pow(1.0 - vT, 1.8) * smoothstep(0.0, 0.05, vT);
  } else if (kind < 1.5) {
    // crisp energy ring + halo
    float x = abs(d - vR);
    float ww = max(w, aa * 1.2);
    float core = 1.0 - smoothstep(ww * 0.45, ww + aa, x);
    float halo = exp(-pow(x / (ww * 3.5), 2.0)) * 0.16;
    a = (core + halo) * pow(1.0 - vT, 1.25) * smoothstep(0.0, 0.04, vT);
  } else {
    // soft disc flash
    float q = d / max(vR, 0.01);
    a = exp(-q * q * 2.2) * pow(1.0 - vT, 1.8);
  }
  a *= vStyle.y;
  if (a < 0.002) discard;
  // dust (shock) decals are lit like smoke; energy rings / flashes are emissive
  vec3 col = vColor * (kind < 0.5 ? uDustTint : vec3(uEmissive)) * a;
  float outA = a * (1.0 - vStyle.w);
  gl_FragColor = vec4(fx_applyFog(col, outA), outA);
  ${OUTPUT_FRAG_GLSL}
}
`;

const _q = new Quaternion();
const _z = new Vector3(0, 0, 1);

export class RingWavePool {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly geometry: InstancedBufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly capacity: number;
  private next = 0;
  private readonly aCenter: InstancedBufferAttribute;
  private readonly aQuat: InstancedBufferAttribute;
  private readonly aTiming: InstancedBufferAttribute;
  private readonly aStyle: InstancedBufferAttribute;
  private readonly aColor: InstancedBufferAttribute;
  private readonly attrs: InstancedBufferAttribute[];
  private time = 0;
  private lastEnd = -Infinity;

  constructor(capacity = 24, renderOrder = 1) {
    this.capacity = capacity;
    const g = new InstancedBufferGeometry();
    g.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3),
    );
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (size: number) => {
      const a = new InstancedBufferAttribute(new Float32Array(capacity * size), size);
      a.setUsage(DynamicDrawUsage);
      return a;
    };
    this.aCenter = mk(3);
    this.aQuat = mk(4);
    this.aTiming = mk(4);
    this.aStyle = mk(4);
    this.aColor = mk(3);
    // all instances start expired
    for (let i = 0; i < capacity; i++) this.aTiming.setXYZW(i, -1e6, 1, 0, 0);
    g.setAttribute('iCenter', this.aCenter);
    g.setAttribute('iQuat', this.aQuat);
    g.setAttribute('iTiming', this.aTiming);
    g.setAttribute('iStyle', this.aStyle);
    g.setAttribute('iColor', this.aColor);
    this.attrs = [this.aCenter, this.aQuat, this.aTiming, this.aStyle, this.aColor];
    g.instanceCount = capacity;
    this.geometry = g;

    this.material = new ShaderMaterial({
      name: 'fx-ring-waves',
      uniforms: {
        ...UniformsUtils.clone(UniformsLib.fog),
        uTime: { value: 0 },
        uDustTint: { value: new Color(1, 1, 1) },
        uEmissive: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      ...PREMULTIPLIED,
    });
    this.mesh = disableRaycast(new Mesh(g, this.material));
    this.mesh.name = 'fx-ring-waves';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
  }

  spawn(s: RingSpawn): void {
    // setFromUnitVectors needs a unit normal; skip degenerate / non-finite input
    const nl = s.normal.length();
    if (!(nl > 1e-6) || !Number.isFinite(s.center.x + s.center.y + s.center.z)) return;
    s.normal.multiplyScalar(1 / nl);
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    _q.setFromUnitVectors(_z, s.normal);
    this.aCenter.setXYZ(
      i,
      s.center.x + s.normal.x * s.lift,
      s.center.y + s.normal.y * s.lift,
      s.center.z + s.normal.z * s.lift,
    );
    this.aQuat.setXYZW(i, _q.x, _q.y, _q.z, _q.w);
    const start = this.time + Math.max(0, s.delay);
    this.aTiming.setXYZW(i, start, Math.max(0.01, s.life), s.r0, s.r1);
    this.aStyle.setXYZW(i, s.thickness, s.alpha, KIND_ID[s.kind], s.additive);
    this.aColor.setXYZ(i, s.color[0], s.color[1], s.color[2]);
    for (let k = 0; k < this.attrs.length; k++) {
      this.attrs[k].clearUpdateRanges();
      this.attrs[k].needsUpdate = true;
    }
    this.lastEnd = Math.max(this.lastEnd, start + s.life);
    this.mesh.visible = true;
  }

  /** Lighting multiplier for dust decals (kind 'shock'), e.g. the theme's smoke tint. */
  setDustTint(c: Color): void {
    (this.material.uniforms.uDustTint.value as Color).copy(c);
  }

  /** Multiplier on emissive rings / flashes (per-theme HDR compensation). */
  setEmissive(k: number): void {
    this.material.uniforms.uEmissive.value = k;
  }

  /** Advance the decal clock (sim-scaled seconds). */
  update(dt: number): void {
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
    this.mesh.visible = this.time <= this.lastEnd;
  }

  clear(): void {
    for (let i = 0; i < this.capacity; i++) this.aTiming.setXYZW(i, -1e6, 1, 0, 0);
    this.aTiming.clearUpdateRanges();
    this.aTiming.needsUpdate = true;
    this.lastEnd = -Infinity;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
