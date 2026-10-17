import { ATMOSPHERE_GLSL } from '../atmosphere';
import { HASH_GLSL, OUTPUT_GLSL } from './common';

export const LANDSCAPE_VERTEX = /* glsl */ `
attribute float aRock;
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vRock;
varying float vLocalY;
varying vec2 vLocalXZ;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vRock = aRock;
  vLocalY = position.y;
  vLocalXZ = position.xz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/**
 * Distant terrain: two-tone key-light shading (lit / shade rock), snow on high gentle slopes
 * (mountains) or sedimentary strata (mesas), sky fill, a rim of light on ridges toward the sun,
 * submersion into the cloud sea, then the shared aerial perspective.
 */
export const LANDSCAPE_FRAGMENT = /* glsl */ `
${ATMOSPHERE_GLSL}
${HASH_GLSL}
uniform vec3 uRockLit;
uniform vec3 uRockShade;
uniform vec3 uSnow;
uniform float uSnowAmount;
/** 0 = mountains, 1 = mesas */
uniform float uKind;
uniform float uSeaTop;
/** Multiplier on the aerial-perspective amount (art control: silhouettes vs. haze). */
uniform float uAerial;
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vRock;
varying float vLocalY;
varying vec2 vLocalXZ;

float rockNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}

void main() {
  vec3 n = normalize(vNormalW);
  // procedural rock detail (mesh-local, so it never swims): breaks up the polygon facets that a
  // telephoto camera reveals, with a bias toward horizontal ledges / gullies
  vec2 q = vLocalXZ / 55.0;
  float hy = vLocalY / 18.0;
  vec2 g = vec2(rockNoise(q + vec2(hy, 0.0)) - rockNoise(q + vec2(hy + 0.6, 0.0)),
                rockNoise(q * 2.3 + 7.1) - rockNoise(q * 2.3 + vec2(7.1, 0.6)));
  float steep = 1.0 - smoothstep(0.55, 0.95, n.y);
  n = normalize(n + vec3(g.x, 0.0, g.y) * (0.35 + 0.45 * steep));
  float ndl = dot(n, uKeyDir);
  float lit = smoothstep(-0.08, 0.5, ndl);
  vec3 litC = uRockLit;
  vec3 shadeC = uRockShade;
  float variation = (vRock - 0.5) * 0.3;

  if (uKind > 0.5) {
    // sedimentary bands + darker cliff faces
    float strata = sin(vWorld.y * 0.12 + vRock * 2.5) * 0.5 + 0.5;
    float strata2 = sin(vWorld.y * 0.034 + 1.3) * 0.5 + 0.5;
    float cliff = 1.0 - smoothstep(0.35, 0.8, n.y);
    litC *= (0.84 + 0.12 * strata + 0.1 * strata2) * (1.0 - 0.12 * cliff);
    shadeC *= 0.9 + 0.12 * strata2;
  } else if (uSnowAmount > 0.0) {
    float line = 430.0 + vRock * 170.0;
    float snow = smoothstep(line, line + 80.0, vLocalY) * smoothstep(0.58, 0.82, n.y) * uSnowAmount;
    litC = mix(litC, uSnow, snow);
    shadeC = mix(shadeC, uSnow * vec3(0.42, 0.5, 0.66), snow * 0.8);
  }

  vec3 col = mix(shadeC, litC, lit) * (1.0 + variation);
  col += uCloudAmbient * 0.06 * max(n.y, 0.0);
  // thin warm rim where ridges catch grazing light
  float rim = pow(1.0 - abs(ndl), 6.0) * step(0.0, ndl);
  col += litC * rim * 0.25;

  // sink into the cloud sea
  float sub = 1.0 - smoothstep(uSeaTop - 45.0, uSeaTop + 20.0, vWorld.y);
  col = mix(col, uCloudFloor, sub);

  vec3 v = vWorld - cameraPosition;
  float dist = length(v);
  vec3 dir = v / dist;
  // haze without most of the sun glow: backlit ranges stay silhouettes against the glowing sky
  vec3 hazeC = hazeColor(dir) + sunGlow(dir) * 0.3;
  col = mix(col, hazeC, fogAmount(cameraPosition, dir, dist) * uAerial);
  gl_FragColor = vec4(col, 1.0);
  ${OUTPUT_GLSL}
}
`;
