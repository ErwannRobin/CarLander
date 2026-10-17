import { BlendFunction, Effect } from 'postprocessing';
import { Uniform, Vector4 } from 'three';

/**
 * Heat shimmer behind the rocket nozzles: a UV warp (mainUv) restricted to two screen-space
 * capsules (nozzle exit -> plume end, radius growing along the plume), driven by animated value
 * noise flowing along the plume. Being a pure UV transform it merges into the bloom pass for free.
 *
 * All inputs are screen-space and set every frame by <PostFX> from the projected nozzle pose.
 */
const FRAGMENT = /* glsl */ `
uniform vec4 segA;
uniform vec4 segB;
uniform vec4 radii;
uniform float strength;
uniform float phase;

float heatHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float heatNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = heatHash(i);
  float b = heatHash(i + vec2(1.0, 0.0));
  float c = heatHash(i + vec2(0.0, 1.0));
  float d = heatHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float plumeMask(vec2 p, vec2 a, vec2 b, float r0, float r1, out float along) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  along = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  float r = mix(r0, r1, along);
  float d = length(pa - ba * along);
  // soft capsule; the shimmer builds up just behind the nozzle lip so the (glowing) nozzle
  // itself stays clean instead of looking torn
  return (1.0 - smoothstep(r * 0.2, r, d)) * smoothstep(0.03, 0.3, along);
}

void mainUv(inout vec2 uv) {
  if (strength <= 0.0) return;
  vec2 asp = vec2(aspect, 1.0);
  vec2 p = uv * asp;
  float ha;
  float hb;
  float ma = plumeMask(p, segA.xy * asp, segA.zw * asp, radii.x, radii.y, ha);
  float mb = plumeMask(p, segB.xy * asp, segB.zw * asp, radii.z, radii.w, hb);
  float m = max(ma, mb);
  if (m <= 0.0) return;
  vec2 axis = (segA.zw - segA.xy) * asp;
  float len = length(axis);
  vec2 flow = len > 1e-5 ? axis / len : vec2(0.0, -1.0);
  // fine cells (~1/5 of the plume radius, clamped to ~6-25 px) streaming along the plume
  float freq = clamp(5.0 / max(radii.y, 1e-3), 36.0, 150.0);
  vec2 q = p * freq - flow * phase * 9.0;
  vec2 n = vec2(heatNoise(q), heatNoise(q + 19.7)) * 2.0 - 1.0;
  n += (vec2(heatNoise(q * 2.1 + 7.1), heatNoise(q * 2.1 + 3.3)) * 2.0 - 1.0) * 0.5;
  uv += n * (m * strength) / asp;
}
`;

export class HeatDistortionEffect extends Effect {
  constructor() {
    super('HeatDistortionEffect', FRAGMENT, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, Uniform>([
        ['segA', new Uniform(new Vector4())],
        ['segB', new Uniform(new Vector4())],
        ['radii', new Uniform(new Vector4())],
        ['strength', new Uniform(0)],
        ['phase', new Uniform(0)],
      ]),
    });
  }

  /** Screen-space plume segments (uv: start.xy, end.zw) for both nozzles. */
  get segA(): Vector4 {
    return this.uniforms.get('segA')!.value as Vector4;
  }
  get segB(): Vector4 {
    return this.uniforms.get('segB')!.value as Vector4;
  }
  /** Capsule radii in uv-height units: (A start, A end, B start, B end). */
  get radii(): Vector4 {
    return this.uniforms.get('radii')!.value as Vector4;
  }
  /** Max UV displacement (uv-height units). 0 disables the warp (shader early-out). */
  get strength(): number {
    return this.uniforms.get('strength')!.value as number;
  }
  set strength(v: number) {
    this.uniforms.get('strength')!.value = v;
  }
  get phase(): number {
    return this.uniforms.get('phase')!.value as number;
  }
  set phase(v: number) {
    this.uniforms.get('phase')!.value = v;
  }
}
