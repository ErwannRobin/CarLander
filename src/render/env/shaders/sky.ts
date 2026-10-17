import { ATMOSPHERE_GLSL } from '../atmosphere';
import { HASH_GLSL, OUTPUT_GLSL } from './common';

/**
 * Sky dome. The dome is centered on the camera and unrotated, so the object-space position is the
 * world-space view direction. Depth is forced to the far plane (z = w): drawn last among opaques it
 * only shades the pixels nothing else covered.
 */
export const SKY_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w;
}
`;

export const SKY_FRAGMENT = /* glsl */ `
${ATMOSPHERE_GLSL}
${HASH_GLSL}
uniform sampler2D uNoise;
/** x: sin(angular radius), y: HDR intensity, z: enabled */
uniform vec3 uSunDisk;
uniform vec3 uSunColor;
/** x: coverage, y: opacity, z: scale, w: speed */
uniform vec4 uCirrus;
uniform vec3 uCirrusColor;
/** Cirrus drift in texture space (wrapped on the CPU). */
uniform vec2 uCirrusDrift;
/** x: density, y: intensity */
uniform vec2 uStars;
/** Radians per screen pixel (star size / disk anti-aliasing). */
uniform float uPixelAngle;
/** 1 when rendering the reflection environment: no disk / stars, cloud floor below the horizon. */
uniform float uEnvMode;
varying vec3 vDir;

float cirrusMask(vec3 dir, out float lightFwd) {
  lightFwd = 0.0;
  if (uCirrus.x <= 0.0 || dir.y <= 0.0) return 0.0;
  // project on a high plane; the + 0.12 flattens the projection toward the horizon. The visible
  // sky spans a few texture tiles: several streak bands, a couple of cirrus regions.
  vec2 p = dir.xz / (dir.y + 0.12) * (0.55 / uCirrus.z);
  vec2 drift = uCirrusDrift;
  float region = texture2D(uNoise, p * 0.23 + vec2(0.31, 0.77) + drift * 0.5).r;
  float regionMask = smoothstep(1.0 - uCirrus.x, 1.0 - uCirrus.x * 0.2, region);
  // fibrous streaks (the A channel is stretched along u), eroded by fine detail
  float streak = texture2D(uNoise, p * vec2(0.7, 1.4) + drift).a;
  float detail = texture2D(uNoise, p * vec2(2.2, 4.4) + drift * 2.0).b;
  float n = streak - (detail - 0.5) * 0.18;
  float c = smoothstep(0.42, 0.98, n) * regionMask;
  c *= c * (3.0 - 2.0 * c);
  c *= smoothstep(0.015, 0.22, dir.y);
  lightFwd = pow(max(dot(dir, uSunDir), 0.0), 6.0);
  return c * uCirrus.y;
}

vec3 starField(vec3 dir) {
  if (uStars.x <= 0.0 || dir.y <= 0.0) return vec3(0.0);
  const float SCALE = 190.0;
  vec3 p = dir * SCALE;
  vec3 cell = floor(p);
  float h = hash13(cell);
  float thr = 1.0 - 0.055 * uStars.x;
  if (h < thr) return vec3(0.0);
  vec3 jitter = hash33(cell + 17.0) * 0.4 + 0.3;
  vec3 sp = normalize(cell + jitter);
  float s = length(cross(dir, sp));
  float size = uPixelAngle * 0.75;
  float b = exp(-(s * s) / (size * size));
  float m = (h - thr) / (1.0 - thr);
  float mag = 0.035 + 2.4 * m * m * m * m;
  float tw = 0.82 + 0.18 * sin(uEnvTime * (1.5 + 5.0 * fract(h * 37.0)) + h * 91.0);
  vec3 tint = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.9, 0.76), fract(h * 53.0));
  float horizon = smoothstep(0.03, 0.35, dir.y);
  float glowMask = 1.0 - clamp(sunAzimuthWeight(dir) * exp(-dir.y / 0.25) * 1.6, 0.0, 0.9);
  return tint * b * mag * tw * horizon * glowMask * uStars.y;
}

void main() {
  vec3 dir = normalize(vDir);

  // clear sky above, haze / cloud floor below; blended across a thin band to avoid a crease
  vec3 above = skyGradient(dir) + sunGlow(dir);
  vec3 floorColor = mix(uSkyBelow, uCloudFloor, uEnvMode);
  vec3 below = belowHorizon(dir, floorColor);
  vec3 col = mix(below, above, smoothstep(-0.004, 0.004, dir.y));

  // sun disk (visible sky only; the directional light provides the specular sun in reflections)
  if (uSunDisk.z > 0.5 && uEnvMode < 0.5) {
    float mu = dot(dir, uSunDir);
    if (mu > 0.0) {
      float s = length(cross(dir, uSunDir));
      float aa = max(uPixelAngle * 1.2, uSunDisk.x * 0.04);
      float disk = 1.0 - smoothstep(uSunDisk.x - aa, uSunDisk.x + aa, s);
      float r = clamp(s / uSunDisk.x, 0.0, 1.0);
      float limb = 0.62 + 0.38 * sqrt(max(1.0 - r * r, 0.0));
      col += uSunColor * uSunDisk.y * disk * limb;
    }
  }

  if (uEnvMode < 0.5) col += starField(dir);

  float fwd;
  float c = cirrusMask(dir, fwd);
  if (c > 0.0) {
    vec3 cc = uCirrusColor * uSkyShape.w * (0.62 + 2.4 * fwd) + sunGlow(dir) * 0.35;
    col = mix(col, cc, c);
  }

  gl_FragColor = vec4(col, 1.0);
  ${OUTPUT_GLSL}
}
`;
