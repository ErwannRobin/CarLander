/**
 * Shared GLSL snippets for FX materials (three.js ShaderMaterial, GLSL ES 3.0 via three's prefix).
 */

/** Cheap hash-based 3D value noise + fbm (iq). Returns [0, 1]. */
export const NOISE_GLSL = /* glsl */ `
float fx_hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float fx_noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(fx_hash(i + vec3(0.0, 0.0, 0.0)), fx_hash(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(fx_hash(i + vec3(0.0, 1.0, 0.0)), fx_hash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(fx_hash(i + vec3(0.0, 0.0, 1.0)), fx_hash(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(fx_hash(i + vec3(0.0, 1.0, 1.0)), fx_hash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z);
}
float fx_fbm3(vec3 p) {
  float s = 0.5 * fx_noise(p);
  p = p * 2.03 + vec3(11.7, 3.1, 7.3);
  s += 0.25 * fx_noise(p);
  p = p * 2.01 + vec3(5.3, 17.9, 1.7);
  s += 0.125 * fx_noise(p);
  return s / 0.875;
}
// Interleaved gradient noise (Jimenez) — per-pixel dither in [0, 1).
float fx_ign(vec2 fragCoord) {
  return fract(52.9829189 * fract(dot(fragCoord, vec2(0.06711056, 0.00583715))));
}
`;

/** Quaternion rotation of a vector. */
export const QUAT_GLSL = /* glsl */ `
vec3 fx_rotate(vec4 q, vec3 v) {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}
`;

/**
 * Fog helper for premultiplied / additive outputs — use after `#include <fog_pars_fragment>`.
 * rgb = mix(rgb, fogColor * outAlpha, f): the "over" part converges to the fog color and the
 * additive part (outAlpha = 0) fades out with distance.
 */
export const FOG_FRAG_GLSL = /* glsl */ `
vec3 fx_applyFog(vec3 col, float outA) {
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float f = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  #else
    float f = smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  return mix(col, fogColor * outA, f);
#else
  return col;
#endif
}
`;

/** Standard three.js output chunks (tone mapping only applies when rendering straight to screen). */
export const OUTPUT_FRAG_GLSL = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;
