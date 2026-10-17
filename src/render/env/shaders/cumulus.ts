import { ATMOSPHERE_GLSL } from '../atmosphere';
import { OUTPUT_GLSL } from './common';

/**
 * Cumulus sprites: camera-facing quads (instanced) sampling the puff atlas. Per-pixel lighting
 * combines the sprite's baked pseudo-normal (rotated into world space through the camera basis)
 * with the sprite's position in its cluster (a rounded "cluster normal"), so whole clusters read as
 * one volume: sunlit domes, grey flat bases, translucent backlit edges.
 */
export const CUMULUS_VERTEX = /* glsl */ `
${ATMOSPHERE_GLSL}
attribute vec4 aCenter;  // xyz world center, w size (m)
attribute vec4 aParams;  // x rotation, y atlas tile, z height fraction in cluster, w opacity
attribute vec4 aNormal;  // xyz cluster normal, w random
attribute vec2 aBase;    // x cluster base y, y cluster radius
uniform float uGrid;
uniform vec2 uNearFade;  // start / end distance (m)
varying vec2 vUv;
varying vec2 vRot;
varying vec3 vWorld;
varying vec3 vClusterN;
varying float vHeight;
varying float vAlpha;
varying float vRand;
varying vec2 vBase;
varying vec4 vFog; // rgb haze color, a amount (per sprite: clusters are small vs. their distance)

void main() {
  vec3 center = aCenter.xyz;
  vBase = aBase;
  vec3 toC = center - cameraPosition;
  float dC = length(toC);
  vec3 dirC = toC / max(dC, 1e-3);
  vFog = vec4(atmosphereColor(dirC), fogAmount(cameraPosition, dirC, dC));
  float size = aCenter.w;
  float c = cos(aParams.x);
  float s = sin(aParams.x);
  vec2 corner = position.xy; // -0.5..0.5
  vec2 rc = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y);
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 world = center + (camRight * rc.x + camUp * rc.y) * size;
  vWorld = world;
  float tile = aParams.y;
  vec2 cell = vec2(mod(tile, uGrid), floor(tile / uGrid));
  vUv = (cell + position.xy + 0.5) / uGrid;
  vRot = vec2(c, s);
  vClusterN = aNormal.xyz;
  vHeight = aParams.z;
  vRand = aNormal.w;
  float dist = length(center - cameraPosition);
  vAlpha = aParams.w * smoothstep(uNearFade.x, uNearFade.y, dist - size * 0.35);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

export const CUMULUS_FRAGMENT = /* glsl */ `
${ATMOSPHERE_GLSL}
uniform sampler2D uAtlas;
uniform vec3 uLit;
uniform vec3 uShade;
uniform float uBright;
varying vec2 vUv;
varying vec2 vRot;
varying vec3 vWorld;
varying vec3 vClusterN;
varying float vHeight;
varying float vAlpha;
varying float vRand;
varying vec2 vBase;
varying vec4 vFog;

void main() {
  vec4 t = texture2D(uAtlas, vUv);
  // soft flat base shared by the whole cluster
  float baseCut = smoothstep(vBase.x - 1.5, vBase.x + vBase.y * 0.16, vWorld.y);
  float a = t.r * vAlpha * baseCut;
  if (a < 0.01) discard;

  // sprite normal (sprite space) -> world, undoing the in-plane rotation
  vec2 nxy = t.gb * 2.0 - 1.0;
  nxy = vec2(vRot.x * nxy.x - vRot.y * nxy.y, vRot.y * nxy.x + vRot.x * nxy.y);
  float nz = sqrt(max(1.0 - dot(nxy, nxy), 0.0));
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 toCam = normalize(cameraPosition - vWorld);
  vec3 ns = normalize(camRight * nxy.x + camUp * nxy.y + toCam * nz);
  vec3 n = normalize(mix(vClusterN, ns, 0.38));

  // cluster-level light with per-sprite detail (keeps whole clusters reading as one volume)
  float clusterL = clamp(dot(vClusterN, uKeyDir) * 0.55 + 0.45, 0.0, 1.0);
  float detailL = dot(ns, uKeyDir) * 0.22;
  float diffuse = clamp(clusterL + detailL, 0.0, 1.0);
  float base = mix(0.55, 1.0, smoothstep(0.0, 0.7, vHeight)) * mix(0.8, 1.0, smoothstep(vBase.x, vBase.x + vBase.y * 0.5, vWorld.y));
  // multiple scattering: cloud cores are never truly dark
  vec3 shade = mix(uShade, uLit, 0.18);
  vec3 col = mix(shade, uLit * uBright, smoothstep(0.0, 1.0, diffuse * base));
  // translucent, backlit edges (silver lining) at the cluster silhouette and thin sprite edges
  vec3 viewDir = -toCam;
  float fwd = pow(max(dot(viewDir, uKeyDir), 0.0), 5.0);
  float rim = 1.0 - abs(dot(vClusterN, toCam));
  float thin = 1.0 - t.a;
  col += uLit * uBright * fwd * clamp(rim * 0.7 + thin * 0.5, 0.0, 1.0) * 0.8;
  // sky fill from above, slight variation per sprite
  col += uCloudAmbient * 0.08 * clamp(n.y, 0.0, 1.0);
  col *= 0.96 + vRand * 0.08;

  col = mix(col, vFog.rgb, vFog.a);
  gl_FragColor = vec4(col * a, a);
  ${OUTPUT_GLSL}
}
`;
