/**
 * ParticlePool — fixed-capacity, GPU-instanced billboard particles. One draw call per pool.
 *
 * - CPU simulation on a flat Float32Array (AoS records, swap-remove compaction): no per-frame
 *   allocations. Curves (size, color, alpha) are evaluated on the CPU and uploaded as a compact
 *   21-float instance record through a single interleaved buffer (one bufferSubData per frame).
 * - Quads are either camera-facing (with rotation) or velocity-stretched (sparks, streaks);
 *   stretching uses the velocity relative to the camera (`refVelocity`) so streaks read correctly
 *   from a chase camera that moves with the car.
 * - Blending: 'additive' (ONE, ONE) or 'premultiplied' (ONE, ONE_MINUS_SRC_ALPHA). Premultiplied
 *   pools support a per-particle `additive` factor (0 = "over", 1 = pure additive), so glowing and
 *   occluding particles can share one sorted draw call. Premultiplied pools sort back-to-front
 *   (O(n) counting sort on quantized view depth).
 * - Sprites come from the shared procedural atlas: 0 = soft glow, 1..4 = lit smoke puffs.
 * - Optional per-particle soft plane: the sprite fades out near a surface plane, removing the hard
 *   intersection line where large smoke billboards cut into the ground.
 * - Optional focus fade: particles between the camera and the focus point (the car) that overlap
 *   it on screen are faded, so smoke never fully hides the car.
 * - Optional local lights (smoke): up to MAX_LOCAL_LIGHTS point / spot lights are evaluated per
 *   particle in the vertex shader (exhaust glow on its own smoke, crash flash, night floodlights).
 * - Emissive multiplier (additive pools): per-theme compensation of HDR glow (see core/theme.ts).
 *
 * Typical use: emitters fill a reusable `ParticleSpawn` and call `pool.spawn(s)`; the owner calls
 * `simulate(dt)` at the start of the frame and `upload(...)` after all emitters ran.
 */
import {
  BufferAttribute,
  type Camera,
  Color,
  DynamicDrawUsage,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  ShaderMaterial,
  type Texture,
  UniformsLib,
  UniformsUtils,
  Vector2,
  Vector3,
  Vector4,
} from 'three';
import { ADDITIVE, PREMULTIPLIED } from './blending';
import { FOG_FRAG_GLSL, OUTPUT_FRAG_GLSL } from './glsl';
import { disableRaycast } from './objects';
import type { RGB } from './math';

export type PoolBlending = 'additive' | 'premultiplied';

/** Max point / spot lights evaluated per particle by pools created with `localLights`. */
export const MAX_LOCAL_LIGHTS = 4;
/** Lambert-ish response of a soft puff to a local light: albedo / pi * average facing (~0.5). */
const LOCAL_LIGHT_SCALE = 0.16;
/** Local-light radiance multiplier saturates smoothly towards this value (see the vertex shader). */
const LOCAL_LIGHT_MAX = 3;

/** Sprite ids in the shared atlas. */
export const SPRITE_GLOW = 0;
/** Smoke puff variants are SPRITE_SMOKE + 0..3. */
export const SPRITE_SMOKE = 1;

/** Random smoke puff variant (1..4). */
export function randomSmokeSprite(): number {
  return SPRITE_SMOKE + Math.floor(Math.random() * 4);
}

/* ---- CPU record layout -------------------------------------------------------------------- */
const PX = 0;
const PY = 1;
const PZ = 2;
const VX = 3;
const VY = 4;
const VZ = 5;
const AGE = 6;
const LIFE = 7;
const S0 = 8;
const S1 = 9;
const SEASE = 10;
const R0 = 11;
const G0 = 12;
const B0 = 13;
const A0 = 14;
const R1 = 15;
const G1 = 16;
const B1 = 17;
const A1 = 18;
const CPOW = 19;
const ROT = 20;
const ROTV = 21;
const FIN = 22;
const FOUT = 23;
const SPRITE = 24;
const ADD = 25;
const STRETCH = 26;
const DRAG = 27;
const GRAV = 28;
const BOUNCE = 29;
const NX = 30;
const NY = 31;
const NZ = 32;
const ND = 33;
const SEED = 34;
const TWINKLE = 35;
const SOFT = 36;
const BLOB = 37;
const CPU_STRIDE = 38;

/* ---- GPU instance record (interleaved, 21 floats):
 *      iA = pos.xyz, size | iB = vel.xyz, stretch | iC = rgb, alpha | iD = rot, sprite, additive, seed
 *      iE = soft plane (n.xyz, d) | iF = soft fade distance (0 = off) */
const GPU_STRIDE = 21;

const SORT_BUCKETS = 2048;

/**
 * Reusable spawn description. Keep one per emitter at module/ref scope, call `reset()` then set
 * the fields you need — no allocation per particle.
 */
export class ParticleSpawn {
  px = 0;
  py = 0;
  pz = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  /** Lifetime (s, sim time). */
  life = 1;
  /** Pre-age (s): spawn as if born `age` seconds ago (sub-frame emission along a moving emitter). */
  age = 0;
  size0 = 0.2;
  size1 = 0.2;
  /** 1 = linear growth; > 1 = ease-out (fast initial expansion, typical for smoke). */
  sizeEase = 1;
  r0 = 1;
  g0 = 1;
  b0 = 1;
  a0 = 1;
  r1 = 1;
  g1 = 1;
  b1 = 1;
  a1 = 0;
  /** Color interpolation exponent: < 1 reaches the end color early (cooling sparks). */
  colorPow = 1;
  rot = 0;
  rotSpeed = 0;
  /** Fraction of life used to fade in / out (smoothstep). */
  fadeIn = 0;
  fadeOut = 0;
  sprite = SPRITE_GLOW;
  /** Premultiplied pools only: 0 = alpha "over", 1 = pure additive. */
  additive = 0;
  /** > 0: velocity-stretched quad; trail length = |relative velocity| * stretch (s). */
  stretch = 0;
  /** Linear drag (1/s). */
  drag = 0;
  /** Multiplier of the pool gravity (negative = buoyant). */
  gravity = 0;
  /** >= 0 enables collision with the plane (n, d): restitution. */
  bounce = -1;
  nx = 0;
  ny = 1;
  nz = 0;
  nd = 0;
  /** 0..1 alpha twinkle amount (sparkles). */
  twinkle = 0;
  /**
   * > 0: fade the sprite out within this distance (m) of the plane (nx, ny, nz, nd) — removes the
   * hard intersection line where large smoke billboards cut into the ground.
   */
  soft = 0;
  /**
   * Smoke sprites only: 0..1 initial "blob" amount. The puff starts as a soft round blob and morphs
   * into the lobed billow over the first 45% of its life (small young puffs otherwise read as
   * popcorn; big old ones keep their cauliflower shape).
   */
  blob = 0;

  reset(): this {
    this.px = this.py = this.pz = 0;
    this.vx = this.vy = this.vz = 0;
    this.life = 1;
    this.age = 0;
    this.size0 = this.size1 = 0.2;
    this.sizeEase = 1;
    this.r0 = this.g0 = this.b0 = this.a0 = 1;
    this.r1 = this.g1 = this.b1 = 1;
    this.a1 = 0;
    this.colorPow = 1;
    this.rot = 0;
    this.rotSpeed = 0;
    this.fadeIn = 0;
    this.fadeOut = 0;
    this.sprite = SPRITE_GLOW;
    this.additive = 0;
    this.stretch = 0;
    this.drag = 0;
    this.gravity = 0;
    this.bounce = -1;
    this.nx = 0;
    this.ny = 1;
    this.nz = 0;
    this.nd = 0;
    this.twinkle = 0;
    this.soft = 0;
    this.blob = 0;
    return this;
  }

  setPosition(v: Vector3): this {
    this.px = v.x;
    this.py = v.y;
    this.pz = v.z;
    return this;
  }

  /** Moves the spawn position by v * scale. */
  offset(v: Vector3, scale = 1): this {
    this.px += v.x * scale;
    this.py += v.y * scale;
    this.pz += v.z * scale;
    return this;
  }

  setVelocity(v: Vector3, scale = 1): this {
    this.vx = v.x * scale;
    this.vy = v.y * scale;
    this.vz = v.z * scale;
    return this;
  }

  addVelocity(v: Vector3, scale = 1): this {
    this.vx += v.x * scale;
    this.vy += v.y * scale;
    this.vz += v.z * scale;
    return this;
  }

  /** Start color (linear RGB, may exceed 1 for HDR/bloom) and alpha. */
  color0(c: RGB, a: number, scale = 1): this {
    this.r0 = c[0] * scale;
    this.g0 = c[1] * scale;
    this.b0 = c[2] * scale;
    this.a0 = a;
    return this;
  }

  /** End color and alpha. */
  color1(c: RGB, a: number, scale = 1): this {
    this.r1 = c[0] * scale;
    this.g1 = c[1] * scale;
    this.b1 = c[2] * scale;
    this.a1 = a;
    return this;
  }

  /** Collide with the plane through `p` with unit normal `n`. */
  collidePlane(n: Vector3, p: Vector3, restitution: number): this {
    this.setPlane(n, p);
    this.bounce = restitution;
    return this;
  }

  /** Soft-fade against the plane through `p` with unit normal `n` (no collision). */
  softPlane(n: Vector3, p: Vector3, distance: number): this {
    this.setPlane(n, p);
    this.soft = distance;
    return this;
  }

  private setPlane(n: Vector3, p: Vector3): void {
    this.nx = n.x;
    this.ny = n.y;
    this.nz = n.z;
    this.nd = n.x * p.x + n.y * p.y + n.z * p.z;
  }
}

export interface ParticlePoolOptions {
  name: string;
  /** Max particles (already scaled by the quality budget). */
  capacity: number;
  blending: PoolBlending;
  texture: Texture;
  /** Back-to-front sorting (default: true for premultiplied pools). */
  sort?: boolean;
  /** Gravity magnitude along -Y (m/s^2). */
  gravity?: number;
  renderOrder?: number;
  /** Max projected size as a fraction of the viewport height (default 1.1). */
  maxScreenSize?: number;
  /** View-depth range over which particles fade in near the camera (m). */
  nearFade?: [number, number];
  /** Pull billboards toward the camera by this fraction of their size (reduces ground clipping). */
  cameraPull?: number;
  /** Fade particles that cover the focus point (see setFocus). */
  focusFade?: boolean;
  /** Light glow-sprite particles with the smoke shading (flat) instead of rendering them emissive. */
  shadeGlowSprites?: boolean;
  /** Evaluate up to MAX_LOCAL_LIGHTS point / spot lights per particle (see setLocalLight). */
  localLights?: boolean;
  /**
   * Max width of velocity-stretched quads as a fraction of the viewport height (0 = unclamped).
   * Sparks flying past the lens otherwise become fat glowing grains; the streak length is kept.
   */
  streakMaxScreen?: number;
}

const VERT = /* glsl */ `
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iC;
attribute vec4 iD;
attribute vec4 iE;
attribute float iF;

uniform vec3 uRefVel;
uniform vec3 uFocus;
uniform float uFocusRadius;
uniform float uFocusMinAlpha;
uniform vec2 uNearFade;
uniform float uMaxScreen;
uniform float uCameraPull;
uniform float uStreakMaxScreen;

uniform vec3 uLightDir;

varying vec2 vUv;
varying vec4 vColor;
varying vec3 vMisc;   // additive, sprite, stretched
varying vec2 vRot;
varying vec3 vLightView;
varying vec2 vSoft;   // signed distance to the soft plane (m), fade distance (0 = off)

#ifdef FX_LOCAL_LIGHTS
uniform vec4 uLocalPos[FX_MAX_LIGHTS];    // world position, cutoff distance (0 = infinite)
uniform vec4 uLocalColor[FX_MAX_LIGHTS];  // linear color * intensity, decay exponent
uniform vec4 uLocalSpot[FX_MAX_LIGHTS];   // spot direction (world), cos(outer angle); w < -1.5: point light
uniform float uLocalInner[FX_MAX_LIGHTS]; // cos(inner angle) (penumbra start)
uniform int uLocalCount;
varying vec3 vLocal;                      // local irradiance -> radiance multiplier
#endif

#include <fog_pars_vertex>

void main() {
  vLightView = normalize(mat3(viewMatrix) * uLightDir);
#ifdef FX_LOCAL_LIGHTS
  // three.js punctual light falloff (inverse power law + smooth cutoff window), spot cone
  vLocal = vec3(0.0);
  for (int i = 0; i < FX_MAX_LIGHTS; i++) {
    if (i >= uLocalCount) break;
    vec3 L = uLocalPos[i].xyz - iA.xyz;
    float d = max(length(L), 0.05);
    float att = pow(d, -uLocalColor[i].w);
    float cutoff = uLocalPos[i].w;
    if (cutoff > 0.0) {
      float x = clamp(1.0 - pow(d / cutoff, 4.0), 0.0, 1.0);
      att *= x * x;
    }
    vec4 sp = uLocalSpot[i];
    if (sp.w > -1.5) att *= smoothstep(sp.w, uLocalInner[i], dot(-L / d, sp.xyz));
    vLocal += uLocalColor[i].rgb * att;
  }
  vLocal *= ${LOCAL_LIGHT_SCALE.toFixed(3)};
  // soft saturation (hue preserved): a crash / ignition flash right next to a puff would otherwise
  // blow it out into a flat white blob; ordinary levels (< ~1) are left nearly untouched
  float lmax = max(vLocal.r, max(vLocal.g, vLocal.b));
  vLocal *= inversesqrt(1.0 + lmax * lmax * ${(1 / (LOCAL_LIGHT_MAX * LOCAL_LIGHT_MAX)).toFixed(4)});
#endif
  vec4 mvPosition = viewMatrix * vec4(iA.xyz, 1.0);
  vec3 mvCenter = mvPosition.xyz;
  float depth = max(-mvPosition.z, 0.05);
  float size = iA.w;

  // clamp the projected size (fill-rate guard when the camera is inside a smoke cloud)
  float maxSize = uMaxScreen * 2.0 * depth / projectionMatrix[1][1];
  size = min(size, maxSize);

  float alpha = iC.a * smoothstep(uNearFade.x, uNearFade.y, depth);

  // focus fade: particles in front of the car that overlap it on screen get thinner
  if (uFocusMinAlpha < 1.0) {
    vec3 focusView = (viewMatrix * vec4(uFocus, 1.0)).xyz;
    float fd = -focusView.z;
    if (fd > 0.1 && depth < fd) {
      vec2 pp = mvPosition.xy / depth;
      vec2 fp = focusView.xy / fd;
      float rr = uFocusRadius / fd + 0.3 * size / depth;
      float k = 1.0 - smoothstep(rr * 0.5, rr * 1.25, length(pp - fp));
      k *= smoothstep(0.4, 2.5, fd - depth);
      alpha *= mix(1.0, uFocusMinAlpha, k);
    }
  }

  if (uCameraPull > 0.0) {
    float pull = min(uCameraPull * size, max(depth - 0.4, 0.0) * 0.5);
    if (pull > 0.0) mvPosition.xyz -= mvPosition.xyz * (pull / length(mvPosition.xyz));
  }

  vec2 corner = position.xy;
  float c = cos(iD.x);
  float s = sin(iD.x);
  float stretched = 0.0;
  if (iB.w > 0.0) {
    vec3 vRel = mat3(viewMatrix) * (iB.xyz - uRefVel);
    float vlen = length(vRel.xy);
    vec2 axis = vlen > 1e-4 ? vRel.xy / vlen : vec2(0.0, 1.0);
    vec2 side = vec2(axis.y, -axis.x); // (side, axis) must stay right-handed or the quad is back-face culled
    float len = size + vlen * iB.w;
    float width = size;
    if (uStreakMaxScreen > 0.0) {
      // thin only actual streaks (blend in with elongation): a particle at rest relative to the
      // camera keeps its round shape instead of collapsing into a sliver
      float thin = min(size, uStreakMaxScreen * 2.0 * depth / projectionMatrix[1][1]);
      width = mix(size, thin, clamp((len - size) / max(size, 1e-4), 0.0, 1.0));
    }
    mvPosition.xy += axis * (corner.y * len - 0.5 * (len - size)) + side * (corner.x * width);
    vRot = vec2(1.0, 0.0);
    stretched = 1.0;
  } else {
    mvPosition.xy += vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * size;
    vRot = vec2(c, s);
  }

  vUv = uv;
  vColor = vec4(iC.rgb, alpha);
  vMisc = vec3(iD.z, iD.y, stretched);
  vSoft = vec2(0.0, iF);
  if (iF > 0.0) {
    // world position of this corner = center + R^T * (view-space offset)
    vec3 worldCorner = iA.xyz + transpose(mat3(viewMatrix)) * (mvPosition.xyz - mvCenter);
    vSoft.x = dot(worldCorner, iE.xyz) - iE.w;
  }
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uSprite;
uniform vec3 uShadeLit;
uniform vec3 uShadeDark;
uniform float uShadeGlow; // 1: glow-sprite particles are lit (flat) like smoke; 0: emissive
uniform float uEmissive;  // multiplier on emissive (unlit) particles
#ifdef FX_LOCAL_LIGHTS
varying vec3 vLocal;
#define FX_LOCAL vLocal
#else
#define FX_LOCAL vec3(0.0)
#endif

varying vec2 vUv;
varying vec4 vColor;
varying vec3 vMisc;
varying vec2 vRot;
varying vec3 vLightView;
varying vec2 vSoft;

#include <fog_pars_fragment>
${FOG_FRAG_GLSL}

// Smooth, core-less density profile for lit vapor (soft puffs, young smoke blobs). The atlas glow
// sprite has a hot core that suits emissive sparks but makes overlapping translucent puffs read as
// strings of beads, especially when a trail is seen end-on from the chase camera. Same integrated
// density and extent as the glow sprite (so effect tunings carry over), without the central spike.
float fx_softDisc(vec2 uv) {
  vec2 q = uv * 2.0 - 1.0;
  float r2 = dot(q, q);
  return 0.75 * exp(-r2 * 5.0) * (1.0 - smoothstep(0.5, 1.0, r2));
}

void main() {
  float sprite = floor(vMisc.y + 0.02);
  float blob = clamp((vMisc.y - sprite) / 0.45, 0.0, 1.0);
  vec3 rgb = vColor.rgb;
  float shape;
  if (sprite < 0.5) {
    if (uShadeGlow > 0.5) {
      // lit (non-emissive) soft puff
      shape = fx_softDisc(vUv);
      rgb *= mix(uShadeDark, uShadeLit, 0.6) + FX_LOCAL;
    } else {
      shape = texture2D(uSprite, vUv * 0.5).r;
      rgb *= uEmissive;
    }
    // streaks: bright head, fading tail
    if (vMisc.z > 0.5) shape *= mix(0.15, 1.0, vUv.y);
  } else {
    float cell = sprite - 1.0;
    vec2 cellOffset = vec2(mod(cell, 2.0), floor(cell * 0.5)) * 0.5;
    vec4 tex = texture2D(uSprite, cellOffset + vUv * 0.5);
    // young puffs: soft round blob, flat-ish lighting
    shape = mix(tex.g, min(1.0, fx_softDisc(vUv) * 1.3), blob);
    vec2 n2 = tex.ba * 2.0 - 1.0;
    n2 = vec2(vRot.x * n2.x - vRot.y * n2.y, vRot.y * n2.x + vRot.x * n2.y);
    vec3 n = vec3(n2, sqrt(max(0.0, 1.0 - dot(n2, n2))));
    float l = clamp(dot(n, vLightView) * 0.6 + 0.5, 0.0, 1.0);
    l = mix(l, 0.62, blob);
    rgb *= mix(uShadeDark, uShadeLit, l) + FX_LOCAL;
  }
  float a = vColor.a * shape;
  if (vSoft.y > 0.0) a *= smoothstep(0.0, vSoft.y, vSoft.x);
  if (a < 0.002) discard;
  vec3 col = rgb * a;
  float outA = a * (1.0 - vMisc.x);
  gl_FragColor = vec4(fx_applyFog(col, outA), outA);
  ${OUTPUT_FRAG_GLSL}
}
`;

const _camPos = new Vector3();
const _camDir = new Vector3();

export class ParticlePool {
  readonly name: string;
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  readonly material: ShaderMaterial;
  readonly blending: PoolBlending;
  /** Gravity magnitude along -Y (m/s^2). */
  gravity: number;

  private geometry: InstancedBufferGeometry;
  private capacity_ = 0;
  private count_ = 0;
  private data = new Float32Array(0);
  private gpu = new Float32Array(0);
  private buffer!: InstancedInterleavedBuffer;
  private readonly range = { start: 0, count: 0 };
  private readonly sorted: boolean;
  // sort scratch
  private depth = new Float32Array(0);
  private keys = new Uint16Array(0);
  private order = new Uint32Array(0);
  private readonly buckets = new Uint32Array(SORT_BUCKETS);

  constructor(opts: ParticlePoolOptions) {
    this.name = opts.name;
    this.blending = opts.blending;
    this.gravity = opts.gravity ?? 14;
    this.sorted = opts.sort ?? opts.blending === 'premultiplied';

    this.material = new ShaderMaterial({
      name: `fx-particles-${opts.name}`,
      uniforms: {
        ...UniformsUtils.clone(UniformsLib.fog),
        uSprite: { value: opts.texture },
        uRefVel: { value: new Vector3() },
        uFocus: { value: new Vector3() },
        uFocusRadius: { value: 2.4 },
        uFocusMinAlpha: { value: opts.focusFade ? 0.1 : 1 },
        uNearFade: { value: new Vector2(...(opts.nearFade ?? [0.3, 1.2])) },
        uMaxScreen: { value: opts.maxScreenSize ?? 1.1 },
        uCameraPull: { value: opts.cameraPull ?? 0 },
        uStreakMaxScreen: { value: opts.streakMaxScreen ?? 0 },
        uLightDir: { value: new Vector3(0, 1, 0) },
        uShadeLit: { value: new Color(1, 1, 1) },
        uShadeDark: { value: new Color(0.6, 0.63, 0.68) },
        uShadeGlow: { value: opts.shadeGlowSprites ? 1 : 0 },
        uEmissive: { value: 1 },
        uLocalPos: { value: Array.from({ length: MAX_LOCAL_LIGHTS }, () => new Vector4()) },
        uLocalColor: { value: Array.from({ length: MAX_LOCAL_LIGHTS }, () => new Vector4()) },
        uLocalSpot: { value: Array.from({ length: MAX_LOCAL_LIGHTS }, () => new Vector4(0, -1, 0, -2)) },
        uLocalInner: { value: new Float32Array(MAX_LOCAL_LIGHTS) },
        uLocalCount: { value: 0 },
      },
      defines: opts.localLights ? { FX_LOCAL_LIGHTS: '', FX_MAX_LIGHTS: MAX_LOCAL_LIGHTS } : {},
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: true,
      ...(opts.blending === 'additive' ? ADDITIVE : PREMULTIPLIED),
    });

    this.geometry = this.buildGeometry(Math.max(1, Math.floor(opts.capacity)));
    this.mesh = disableRaycast(new Mesh(this.geometry, this.material));
    this.mesh.name = `fx-pool-${opts.name}`;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = opts.renderOrder ?? 0;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
  }

  get count(): number {
    return this.count_;
  }

  get capacity(): number {
    return this.capacity_;
  }

  private buildGeometry(capacity: number): InstancedBufferGeometry {
    this.capacity_ = capacity;
    this.count_ = 0;
    this.data = new Float32Array(capacity * CPU_STRIDE);
    this.gpu = new Float32Array(capacity * GPU_STRIDE);
    this.depth = new Float32Array(capacity);
    this.keys = new Uint16Array(capacity);
    this.order = new Uint32Array(capacity);

    const g = new InstancedBufferGeometry();
    g.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3),
    );
    g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.buffer = new InstancedInterleavedBuffer(this.gpu, GPU_STRIDE, 1);
    this.buffer.setUsage(DynamicDrawUsage);
    g.setAttribute('iA', new InterleavedBufferAttribute(this.buffer, 4, 0));
    g.setAttribute('iB', new InterleavedBufferAttribute(this.buffer, 4, 4));
    g.setAttribute('iC', new InterleavedBufferAttribute(this.buffer, 4, 8));
    g.setAttribute('iD', new InterleavedBufferAttribute(this.buffer, 4, 12));
    g.setAttribute('iE', new InterleavedBufferAttribute(this.buffer, 4, 16));
    g.setAttribute('iF', new InterleavedBufferAttribute(this.buffer, 1, 20));
    g.instanceCount = 0;
    return g;
  }

  /** Reallocates for a new capacity (quality change). Clears all particles. */
  setCapacity(capacity: number): void {
    const cap = Math.max(1, Math.floor(capacity));
    if (cap === this.capacity_) return;
    const old = this.geometry;
    this.geometry = this.buildGeometry(cap);
    this.mesh.geometry = this.geometry;
    old.dispose();
    this.mesh.visible = false;
  }

  /** Removes every particle immediately. */
  clear(): void {
    this.count_ = 0;
    this.geometry.instanceCount = 0;
    this.mesh.visible = false;
  }

  /**
   * Adds a particle. When the pool is full, the most-aged of a few random particles is recycled
   * (bursts stay visible even when continuous emitters saturate the budget).
   */
  spawn(s: ParticleSpawn): void {
    // Reject non-finite records (degenerate input such as a zero normal upstream): a NaN position
    // would corrupt the counting sort (NaN depth keys) and render garbage for the particle's life.
    if (!Number.isFinite(s.px + s.py + s.pz + s.vx + s.vy + s.vz + s.size0 + s.size1)) return;
    let i: number;
    if (this.count_ < this.capacity_) {
      i = this.count_++;
    } else {
      i = 0;
      let best = -1;
      for (let k = 0; k < 4; k++) {
        const j = Math.floor(Math.random() * this.capacity_);
        const o = j * CPU_STRIDE;
        const t = this.data[o + AGE] / this.data[o + LIFE];
        if (t > best) {
          best = t;
          i = j;
        }
      }
    }
    const d = this.data;
    const o = i * CPU_STRIDE;
    const age = s.age > 0 ? s.age : 0;
    d[o + PX] = s.px + s.vx * age;
    d[o + PY] = s.py + s.vy * age;
    d[o + PZ] = s.pz + s.vz * age;
    d[o + VX] = s.vx;
    d[o + VY] = s.vy;
    d[o + VZ] = s.vz;
    d[o + AGE] = age;
    d[o + LIFE] = s.life > 1e-3 ? s.life : 1e-3;
    d[o + S0] = s.size0;
    d[o + S1] = s.size1;
    d[o + SEASE] = s.sizeEase;
    d[o + R0] = s.r0;
    d[o + G0] = s.g0;
    d[o + B0] = s.b0;
    d[o + A0] = s.a0;
    d[o + R1] = s.r1;
    d[o + G1] = s.g1;
    d[o + B1] = s.b1;
    d[o + A1] = s.a1;
    d[o + CPOW] = s.colorPow;
    d[o + ROT] = s.rot;
    d[o + ROTV] = s.rotSpeed;
    d[o + FIN] = s.fadeIn;
    d[o + FOUT] = s.fadeOut;
    d[o + SPRITE] = s.sprite;
    d[o + ADD] = this.blending === 'additive' ? 1 : s.additive;
    d[o + STRETCH] = s.stretch;
    d[o + DRAG] = s.drag;
    d[o + GRAV] = s.gravity;
    d[o + BOUNCE] = s.bounce;
    d[o + NX] = s.nx;
    d[o + NY] = s.ny;
    d[o + NZ] = s.nz;
    d[o + ND] = s.nd;
    d[o + SEED] = Math.random();
    d[o + TWINKLE] = s.twinkle;
    d[o + SOFT] = s.soft;
    d[o + BLOB] = s.blob < 0 ? 0 : s.blob > 1 ? 1 : s.blob;
  }

  /** Ages, integrates and culls particles. */
  simulate(dt: number): void {
    if (dt <= 0 || this.count_ === 0) return;
    const d = this.data;
    const g = this.gravity * dt;
    let n = this.count_;
    let i = 0;
    while (i < n) {
      const o = i * CPU_STRIDE;
      const age = d[o + AGE] + dt;
      if (age >= d[o + LIFE]) {
        n--;
        if (i !== n) d.copyWithin(o, n * CPU_STRIDE, n * CPU_STRIDE + CPU_STRIDE);
        continue;
      }
      d[o + AGE] = age;
      let vx = d[o + VX];
      let vy = d[o + VY] - g * d[o + GRAV];
      let vz = d[o + VZ];
      const drag = d[o + DRAG];
      if (drag > 0) {
        const k = 1 / (1 + drag * dt);
        vx *= k;
        vy *= k;
        vz *= k;
      }
      let px = d[o + PX] + vx * dt;
      let py = d[o + PY] + vy * dt;
      let pz = d[o + PZ] + vz * dt;
      const e = d[o + BOUNCE];
      if (e >= 0) {
        const nx = d[o + NX];
        const ny = d[o + NY];
        const nz = d[o + NZ];
        const dist = px * nx + py * ny + pz * nz - d[o + ND];
        if (dist < 0) {
          px -= nx * dist;
          py -= ny * dist;
          pz -= nz * dist;
          const vn = vx * nx + vy * ny + vz * nz;
          if (vn < 0) {
            // reflect the normal component, keep 65% of the tangential (sliding friction)
            const tx = vx - vn * nx;
            const ty = vy - vn * ny;
            const tz = vz - vn * nz;
            vx = tx * 0.65 - vn * e * nx;
            vy = ty * 0.65 - vn * e * ny;
            vz = tz * 0.65 - vn * e * nz;
          }
        }
      }
      d[o + PX] = px;
      d[o + PY] = py;
      d[o + PZ] = pz;
      d[o + VX] = vx;
      d[o + VY] = vy;
      d[o + VZ] = vz;
      i++;
    }
    this.count_ = n;
  }

  /**
   * Evaluates curves, sorts (if enabled) and uploads instance data for this frame.
   * `refVelocity` = camera velocity (world, m/s of sim time) used for streak stretching.
   */
  upload(camera: Camera, refVelocity: Vector3): void {
    const n = this.count_;
    this.mesh.visible = n > 0;
    this.geometry.instanceCount = n;
    if (n === 0) return;

    (this.material.uniforms.uRefVel.value as Vector3).copy(refVelocity);
    const order = this.sorted ? this.sortBackToFront(camera, n) : null;
    const d = this.data;
    const g = this.gpu;
    for (let j = 0; j < n; j++) {
      const i = order ? order[j] : j;
      const o = i * CPU_STRIDE;
      const w = j * GPU_STRIDE;
      const age = d[o + AGE];
      const t = age / d[o + LIFE];

      const se = d[o + SEASE];
      const st = se === 1 ? t : 1 - Math.pow(1 - t, se);
      const cp = d[o + CPOW];
      const ct = cp === 1 ? t : Math.pow(t, cp);

      let a = d[o + A0] + (d[o + A1] - d[o + A0]) * t;
      const fin = d[o + FIN];
      if (fin > 0 && t < fin) {
        const x = t / fin;
        a *= x * x * (3 - 2 * x);
      }
      const fout = d[o + FOUT];
      if (fout > 0 && t > 1 - fout) {
        const x = (1 - t) / fout;
        a *= x * x * (3 - 2 * x);
      }
      const tw = d[o + TWINKLE];
      if (tw > 0) a *= 1 - tw * (0.5 + 0.5 * Math.sin(age * 37 + d[o + SEED] * 43));

      g[w] = d[o + PX];
      g[w + 1] = d[o + PY];
      g[w + 2] = d[o + PZ];
      g[w + 3] = d[o + S0] + (d[o + S1] - d[o + S0]) * st;
      g[w + 4] = d[o + VX];
      g[w + 5] = d[o + VY];
      g[w + 6] = d[o + VZ];
      g[w + 7] = d[o + STRETCH];
      g[w + 8] = d[o + R0] + (d[o + R1] - d[o + R0]) * ct;
      g[w + 9] = d[o + G0] + (d[o + G1] - d[o + G0]) * ct;
      g[w + 10] = d[o + B0] + (d[o + B1] - d[o + B0]) * ct;
      g[w + 11] = a;
      g[w + 12] = d[o + ROT] + d[o + ROTV] * age;
      // sprite id + blob amount in the fractional part (0..0.45): keeps the GPU record compact
      const blob = d[o + BLOB];
      g[w + 13] = d[o + SPRITE] + (blob > 0 && t < 0.45 ? blob * (1 - t / 0.45) * 0.45 : 0);
      g[w + 14] = d[o + ADD];
      g[w + 15] = d[o + SEED];
      g[w + 16] = d[o + NX];
      g[w + 17] = d[o + NY];
      g[w + 18] = d[o + NZ];
      g[w + 19] = d[o + ND];
      g[w + 20] = d[o + SOFT];
    }

    // Single persistent update range (no allocation; three clears the array after upload).
    this.range.start = 0;
    this.range.count = n * GPU_STRIDE;
    this.buffer.updateRanges.length = 0;
    this.buffer.updateRanges.push(this.range);
    this.buffer.needsUpdate = true;
  }

  /** Counting sort on quantized view depth, far to near. */
  private sortBackToFront(camera: Camera, n: number): Uint32Array {
    camera.getWorldPosition(_camPos);
    camera.getWorldDirection(_camDir);
    const d = this.data;
    const depth = this.depth;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < n; i++) {
      const o = i * CPU_STRIDE;
      const z = (d[o + PX] - _camPos.x) * _camDir.x + (d[o + PY] - _camPos.y) * _camDir.y + (d[o + PZ] - _camPos.z) * _camDir.z;
      depth[i] = z;
      if (z < min) min = z;
      if (z > max) max = z;
    }
    const buckets = this.buckets;
    buckets.fill(0);
    const keys = this.keys;
    const scale = (SORT_BUCKETS - 1) / Math.max(max - min, 1e-4);
    for (let i = 0; i < n; i++) {
      const k = SORT_BUCKETS - 1 - Math.floor((depth[i] - min) * scale);
      keys[i] = k;
      buckets[k]++;
    }
    let sum = 0;
    for (let b = 0; b < SORT_BUCKETS; b++) {
      const c = buckets[b];
      buckets[b] = sum;
      sum += c;
    }
    const order = this.order;
    for (let i = 0; i < n; i++) order[buckets[keys[i]]++] = i;
    return order;
  }

  /** Focus point (world) + radius (m) for the focus fade (particles covering it get thinner). */
  setFocus(worldPos: Vector3, radius: number): void {
    (this.material.uniforms.uFocus.value as Vector3).copy(worldPos);
    this.material.uniforms.uFocusRadius.value = radius;
  }

  /** Multiplier on emissive (unlit) particles — per-theme HDR compensation. */
  setEmissive(k: number): void {
    this.material.uniforms.uEmissive.value = k;
  }

  /**
   * Local light `i` (pools created with `localLights`): world position, linear color, intensity,
   * cutoff distance (0 = infinite) and decay exponent like three's PointLight / SpotLight. For spot
   * lights pass the unit world direction and cos(outer) / cos(inner) cone angles; null = point light.
   */
  setLocalLight(
    i: number,
    position: Vector3,
    color: Color,
    intensity: number,
    distance: number,
    decay: number,
    spotDirection: Vector3 | null,
    cosOuter: number,
    cosInner: number,
  ): void {
    if (i < 0 || i >= MAX_LOCAL_LIGHTS) return;
    const u = this.material.uniforms;
    (u.uLocalPos.value as Vector4[])[i].set(position.x, position.y, position.z, distance);
    (u.uLocalColor.value as Vector4[])[i].set(color.r * intensity, color.g * intensity, color.b * intensity, decay);
    const sp = (u.uLocalSpot.value as Vector4[])[i];
    if (spotDirection) sp.set(spotDirection.x, spotDirection.y, spotDirection.z, cosOuter);
    else sp.set(0, -1, 0, -2);
    (u.uLocalInner.value as Float32Array)[i] = cosInner;
  }

  /** Number of active local lights (0..MAX_LOCAL_LIGHTS). */
  setLocalLightCount(n: number): void {
    this.material.uniforms.uLocalCount.value = Math.max(0, Math.min(MAX_LOCAL_LIGHTS, n));
  }

  /** Smoke lighting: unit world-space direction towards the light, plus lit / shadow tints. */
  setLighting(lightDirWorld: Vector3, lit: Color, dark: Color): void {
    (this.material.uniforms.uLightDir.value as Vector3).copy(lightDirWorld);
    (this.material.uniforms.uShadeLit.value as Color).copy(lit);
    (this.material.uniforms.uShadeDark.value as Color).copy(dark);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
