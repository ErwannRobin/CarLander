import { ATMOSPHERE_GLSL } from '../atmosphere';
import { OUTPUT_GLSL } from './common';

/**
 * Cloud sea: a horizontal disk at the slab top that follows the camera. The cloud floor is a 2.5D
 * height field inside the slab [top - thickness, top] (large masses carved into billowy heads,
 * from the tileable noise texture). Each fragment traces its view ray against it:
 *  - Lipschitz-safe height-field tracing (step = height gap / slope bound) + bisection refinement,
 *    with a cheaper 2-fetch height function while marching (the full height decides hits once the
 *    ray is within the coarse/fine error band, so silhouettes don't leak);
 *  - shading at the exact hit: normal from the height gradient, self-shadowing toward the key
 *    light, tall heads brighter than valleys, forward-scattered silver lining;
 *  - opacity from the cloud column depth along the ray (thin heads stay soft);
 *  - silhouette antialiasing from the ray's closest approach (in pixels) to heads it skims past;
 *  - gaps reveal the deep haze with a faint parallaxed ground pattern far below;
 *  - the shared aerial perspective on top, and an alpha fade at the disk edge into the sky dome.
 */
export const CLOUD_SEA_VERTEX = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export const CLOUD_SEA_FRAGMENT = /* glsl */ `
${ATMOSPHERE_GLSL}
uniform sampler2D uNoise;
uniform vec2 uDrift0;
uniform vec2 uDrift1;
/** Tile size (m) of the billowy heads carved into the masses. */
uniform float uBillowScale;
uniform float uPixelAngle;
/** x: disk center x, y: disk center z, z: fade start radius, w: radius */
uniform vec4 uDisk;
/** Opacity of the deep haze seen through gaps. */
uniform float uDeepOpacity;
/** HDR multiplier on the sunlit cloud color. */
uniform float uCloudBright;
varying vec3 vWorld;

#ifndef STEPS
#define STEPS 22
#endif
#define MAX_MARCH 1100.0
#define TEX_RES 256.0

float topHeight(vec2 xz, float lod) {
  // large masses (uCloudParams.z m per tile) carved into billowy heads (uBillowScale m per tile)
  vec2 uv = xz / uCloudParams.z + uDrift0;
  float base = textureLod(uNoise, uv, lod).r;
  vec2 uv2 = xz / uBillowScale + uDrift1;
  float lod2 = max(lod + log2(uCloudParams.z / uBillowScale), 0.0);
  vec3 n2 = textureLod(uNoise, uv2, lod2).gbr;
  // a finer octave of puffs (cauliflower texture on the heads)
  float n3 = textureLod(uNoise, uv2 * 3.1 + vec2(0.29, 0.61), lod2 + 1.63).g;
  float cov = uCloudParams.x;
  float mass = smoothstep(1.0 - cov - 0.12, 1.0 - cov + 0.38, base);
  float billow = n2.x * 0.78 + n3 * 0.22;
  float fine = n2.y;
  // billows shape the tops; at the mass edges they break the cloud into separate heads
  float h = mass * (0.4 + 0.6 * billow) - (1.0 - mass) * (1.0 - billow) * 0.35 - (fine - 0.5) * 0.05;
  return clamp(h, 0.0, 1.0);
}

/** March variant: masses + billows only (2 fetches); the fine octave only matters for shading. */
float topHeightCoarse(vec2 xz, float lod) {
  vec2 uv = xz / uCloudParams.z + uDrift0;
  float base = textureLod(uNoise, uv, lod).r;
  vec2 uv2 = xz / uBillowScale + uDrift1;
  float lod2 = max(lod + log2(uCloudParams.z / uBillowScale), 0.0);
  vec2 n2 = textureLod(uNoise, uv2, lod2).gb;
  float cov = uCloudParams.x;
  float mass = smoothstep(1.0 - cov - 0.12, 1.0 - cov + 0.38, base);
  float billow = n2.x * 0.78 + 0.11;
  float h = mass * (0.4 + 0.6 * billow) - (1.0 - mass) * (1.0 - billow) * 0.35 - (n2.y - 0.5) * 0.05;
  return clamp(h, 0.0, 1.0);
}

void main() {
  vec3 ro = cameraPosition;
  vec3 toFrag = vWorld - ro;
  float tPlane = length(toFrag);
  vec3 rd = toFrag / tPlane;

  float top = uFogParams.w;
  float thick = uCloudParams.w;
  float bottom = top - thick;

  // ray segment inside the slab
  float tEnter = ro.y > top ? tPlane : 0.0;
  float tExit = rd.y < -1e-4 ? (bottom - ro.y) / rd.y : tEnter + MAX_MARCH;
  float span = clamp(tExit - tEnter, 0.0, MAX_MARCH);

  // texture LOD from the pixel footprint (explicit: the march loop is non-uniform control flow)
  float texel = uCloudParams.z / TEX_RES;
  float lod = log2(max(tEnter * uPixelAngle / texel, 1e-4)) + 0.5 * log2(1.0 / max(abs(rd.y), 0.05));
  lod = max(lod, 0.0);

  // Height-field tracing: the step is the ray's height above the local cloud top divided by a
  // slope bound, so the ray can never jump over a head; finish with a short bisection.
  const float SLOPE = 0.9;
  float stepScale = 1.0 / (max(-rd.y, 0.0) + SLOPE * length(rd.xz));
  float t = tEnter;
  float tPrev = tEnter;
  float tHitS = -1.0;
  float tEnd = tEnter + span;
  bool done = false;
  // closest approach (in pixels) to heads the ray skims past: silhouette antialiasing
  float pxAngle = max(uPixelAngle, 1e-5);
  float minPx = 1e9;
  float tAtMin = 0.0;
  // the coarse height omits the finest puff octave: it can be off by up to ~0.066 * thick
  float fineBand = 0.07 * thick;
  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * t;
    float hC = topHeightCoarse(p.xz, lod);
    float gap = p.y - (bottom + hC * thick);
    float eps = 0.3 + t * 0.0012;
    if (gap < eps + fineBand) {
      // inside the coarse/fine error band: decide with the full height (otherwise rays skimming a
      // puff the coarse field misses leak the gap color through silhouettes as 1 px notches)
      hC = topHeight(p.xz, lod);
      gap = p.y - (bottom + hC * thick);
      if (gap < eps) {
        tHitS = t;
        done = true;
        break;
      }
    }
    // only real heads count as near misses (not the empty slab floor in the gaps)
    float px = gap / (t * pxAngle);
    if (hC > 0.12 && px < minPx) {
      minPx = px;
      tAtMin = t;
    }
    tPrev = t;
    t += max(gap * stepScale, max(0.6, t * 0.004));
    if (t > tEnd) {
      done = true;
      break;
    }
  }
  // out of iterations while still skimming the tops: a grazing hit, not a gap
  if (!done) {
    tHitS = t;
  }
  float edgeCover = 1.0 - smoothstep(0.0, 1.6, minPx);
  // a true silhouette is well in front of whatever the ray finally hits; a close approach right
  // before the hit is the same surface seen at a grazing angle (would draw contour lines)
  if (tHitS > 0.0 && tHitS - tAtMin < max(35.0, 0.1 * tAtMin)) edgeCover = 0.0;

  float alpha = 0.0;
  vec3 color = vec3(0.0);
  float tHit = tEnter + span;
  if (tHitS > 0.0) {
    float t0 = tPrev;
    float t1 = tHitS;
    for (int k = 0; k < 4; k++) {
      float tm = 0.5 * (t0 + t1);
      vec3 pm = ro + rd * tm;
      if (topHeight(pm.xz, lod) - (pm.y - bottom) / thick > 0.0) t1 = tm;
      else t0 = tm;
    }
    vec3 hit = ro + rd * t1;

    // height-field normal + self shadowing toward the key light
    float e = uBillowScale * 0.03;
    float h0 = topHeight(hit.xz, lod);
    // grazing contact with the empty slab floor of a gap is not a cloud
    if (h0 > 0.03) {
      tHit = t1;
      float hx = topHeight(hit.xz + vec2(e, 0.0), lod);
      float hz = topHeight(hit.xz + vec2(0.0, e), lod);
      vec3 n = normalize(vec3((h0 - hx) * thick / e, 1.0, (h0 - hz) * thick / e));
      vec2 lxz = uKeyDir.xz / max(length(uKeyDir.xz), 1e-3);
      float hs = topHeight(hit.xz + lxz * uBillowScale * 0.1, lod + 0.5);
      float selfShadow = clamp(1.0 - (hs - h0) * 3.0, 0.0, 1.0);

      // opacity from the cloud column depth along the ray (thin heads / edges stay soft)
      float column = h0 * thick / max(-rd.y, 0.06);
      alpha = 1.0 - exp(-uCloudParams.y * column);

      float ndl = dot(n, uKeyDir);
      float wrap = clamp(ndl * 0.6 + 0.4, 0.0, 1.0);
      // tall heads catch more light; valleys sink into a cool shade
      float heightLight = smoothstep(0.05, 0.8, h0);
      float lightAmt = pow(wrap, 0.85) * selfShadow * (0.5 + 0.5 * heightLight);
      vec3 valley = mix(uCloudShade * 0.82, uCloudShade, heightLight);
      color = mix(valley, uCloudLit * uCloudBright, smoothstep(0.05, 0.95, lightAmt));
      color += uCloudAmbient * 0.08 * clamp(n.y, 0.0, 1.0);
      // silver lining: thin edges glow when looking toward the light
      float fwd = pow(max(dot(rd, uKeyDir), 0.0), 5.0);
      color += uCloudLit * fwd * 0.6 * (1.0 - alpha * 0.7) * selfShadow;
    }
  }

  // soften aliased silhouettes: partial coverage by heads the ray passed within ~1.5 px of
  if (edgeCover > 0.0) {
    vec3 rimC = mix(uCloudShade, uCloudLit * uCloudBright, 0.62);
    float c = edgeCover * 0.85;
    color = mix(color, rimC, c * (1.0 - alpha * 0.25));
    alpha = mix(alpha, 1.0, c);
  }

  // gaps: the deep haze below the slab, with a faint, parallaxed ground pattern far below
  // (sampled on a plane ~900 m under the clouds) so the void reads as depth, not as a flat sea
  float deep = (1.0 - alpha) * uDeepOpacity;
  vec3 deepC = uSkyBelow;
  if (deep > 0.0 && rd.y < -0.02) {
    float tg = (top - 900.0 - ro.y) / rd.y;
    vec2 g = (ro.xz + rd.xz * tg) / 7000.0;
    // footprint LOD including the grazing-angle stretch (avoids moire rings near the horizon)
    float gl = log2(max(tg * uPixelAngle / (7000.0 / TEX_RES), 1e-4)) + log2(1.0 / max(-rd.y, 0.04));
    float ground = textureLod(uNoise, g + vec2(0.61, 0.13), max(gl, 0.0)).r;
    float ground2 = textureLod(uNoise, g * 3.7 + vec2(0.27, 0.83), max(gl + 1.9, 0.0)).b;
    float detailFade = 1.0 - smoothstep(-0.5, 2.5, gl);
    deepC *= 0.72 + 0.4 * ground + 0.16 * (ground2 - 0.5) * detailFade;
  }
  vec3 premul = color * alpha + deepC * deep;
  float a = alpha + deep;

  // aerial perspective (haze in front of everything)
  float f = fogAmount(ro, rd, tHit);
  // haze target follows the dome's lower hemisphere: horizon haze far away, darker looking down
  premul = mix(premul, belowHorizon(rd, uSkyBelow), f);
  a = mix(a, 1.0, f);

  // fade the disk edge into the sky dome (which renders the same haze)
  float r = length(vWorld.xz - uDisk.xy);
  float edge = 1.0 - smoothstep(uDisk.z, uDisk.w, r);
  gl_FragColor = vec4(premul * edge, a * edge);
  ${OUTPUT_GLSL}
}
`;
