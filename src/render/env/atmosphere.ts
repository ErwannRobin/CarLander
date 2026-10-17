/**
 * Shared atmosphere model.
 *
 * One set of uniforms (`AtmosphereUniforms`) is created per <World> and shared *by reference* by
 * every far-field material (sky dome, env-map sky, cloud sea, cumulus, landscape), so a theme change
 * updates all of them at once and every element fades into exactly the same haze — which is what
 * hides the seams between the cloud sea, the landscape and the sky dome at the horizon.
 *
 * GLSL conventions: all colors are linear HDR. `uSunDir` points toward the sky sun (may be below
 * the horizon at night); `uKeyDir` toward the shadow-casting key light (sun or moon).
 */
import { Color, Vector2, Vector3, Vector4 } from 'three';
import { directionFromAngles, keyLightDirection, type ThemeDef } from './themes';

export interface AtmosphereUniforms {
  [name: string]: { value: unknown };
  uSunDir: { value: Vector3 };
  uKeyDir: { value: Vector3 };
  uKeyColor: { value: Color };
  uSkyZenith: { value: Color };
  uSkyHorizon: { value: Color };
  uSkyHaze: { value: Color };
  uSkyHazeSun: { value: Color };
  uSkyBelow: { value: Color };
  /** x: curve, y: haze height, z: sun focus, w: intensity */
  uSkyShape: { value: Vector4 };
  uGlowColor: { value: Color };
  /** x: tight, y: tight power, z: wide, w: wide power */
  uGlow: { value: Vector4 };
  /** x: FogExp2 density, y: height haze density, z: height falloff, w: reference height (cloud top) */
  uFogParams: { value: Vector4 };
  uCloudLit: { value: Color };
  uCloudShade: { value: Color };
  uCloudAmbient: { value: Color };
  /** x: coverage, y: density, z: horizontal scale (m), w: thickness (m) */
  uCloudParams: { value: Vector4 };
  uCloudWind: { value: Vector2 };
  /** Average color of the cloud floor seen from above (env map lower hemisphere). */
  uCloudFloor: { value: Color };
  /** Seconds, wrapped to keep float precision. */
  uEnvTime: { value: number };
}

export function createAtmosphereUniforms(): AtmosphereUniforms {
  return {
    uSunDir: { value: new Vector3(0, 1, 0) },
    uKeyDir: { value: new Vector3(0, 1, 0) },
    uKeyColor: { value: new Color(1, 1, 1) },
    uSkyZenith: { value: new Color() },
    uSkyHorizon: { value: new Color() },
    uSkyHaze: { value: new Color() },
    uSkyHazeSun: { value: new Color() },
    uSkyBelow: { value: new Color() },
    uSkyShape: { value: new Vector4(0.5, 0.1, 2, 1) },
    uGlowColor: { value: new Color() },
    uGlow: { value: new Vector4() },
    uFogParams: { value: new Vector4() },
    uCloudLit: { value: new Color() },
    uCloudShade: { value: new Color() },
    uCloudAmbient: { value: new Color() },
    uCloudParams: { value: new Vector4(0.7, 0.05, 1500, 60) },
    uCloudWind: { value: new Vector2() },
    uCloudFloor: { value: new Color() },
    uEnvTime: { value: 0 },
  };
}

const _c = new Color();

/** Writes a theme into the shared uniforms (no allocations). */
export function applyThemeToAtmosphere(u: AtmosphereUniforms, t: ThemeDef): void {
  directionFromAngles(t.sun.elevationDeg, t.sun.azimuthDeg, u.uSunDir.value);
  keyLightDirection(t, u.uKeyDir.value);
  const key = t.keyLight ?? t.sun;
  u.uKeyColor.value.set(key.color).multiplyScalar(key.intensity);

  const s = t.sky;
  u.uSkyZenith.value.set(s.zenith);
  u.uSkyHorizon.value.set(s.horizon);
  u.uSkyHaze.value.set(s.haze);
  u.uSkyHazeSun.value.set(s.hazeSun);
  u.uSkyBelow.value.set(s.below);
  u.uSkyShape.value.set(s.curve, s.hazeHeight, s.sunFocus, s.intensity);
  u.uGlowColor.value.set(s.glow.color);
  u.uGlow.value.set(s.glow.tight, s.glow.tightPower, s.glow.wide, s.glow.widePower);

  u.uFogParams.value.set(t.fog.density, t.fog.heightDensity, t.fog.heightFalloff, t.clouds.seaTop);

  const c = t.clouds;
  u.uCloudLit.value.set(c.lit);
  u.uCloudShade.value.set(c.shade);
  u.uCloudAmbient.value.set(c.ambient);
  u.uCloudParams.value.set(c.coverage, c.density, c.scale, c.seaThickness);
  u.uCloudWind.value.set(c.wind[0], c.wind[1]);

  // Floor seen from the facility: mostly lit tops where covered, the deep haze in the gaps.
  const lit = _c.set(c.lit);
  const floor = u.uCloudFloor.value.set(c.shade).lerp(lit, 0.42);
  floor.lerp(u.uSkyBelow.value, 1 - Math.min(1, c.coverage * 1.1));
}

/**
 * GLSL shared by every far-field shader. Declares the atmosphere uniforms and:
 *  - hazeColor(dir)        horizon haze (warmer toward the sun azimuth)
 *  - skyGradient(dir)      clear-sky gradient + haze band (no glow / disk / clouds)
 *  - sunGlow(dir)          mie-like glow around the sky sun
 *  - atmosphereColor(dir)  color of "infinitely far" things in that direction (horizon sky)
 *  - fogAmount(...)        FogExp2-compatible distance fog + exponential height haze
 *  - applyAerial(...)      aerial perspective toward atmosphereColor
 */
export const ATMOSPHERE_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyHaze;
uniform vec3 uSkyHazeSun;
uniform vec3 uSkyBelow;
uniform vec4 uSkyShape;
uniform vec3 uGlowColor;
uniform vec4 uGlow;
uniform vec4 uFogParams;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform vec3 uCloudAmbient;
uniform vec4 uCloudParams;
uniform vec2 uCloudWind;
uniform vec3 uCloudFloor;
uniform float uEnvTime;

float sunAzimuthWeight(vec3 dir) {
  vec2 a = dir.xz;
  vec2 b = uSunDir.xz;
  float la = length(a);
  float lb = length(b);
  float c = (la > 1e-4 && lb > 1e-4) ? dot(a, b) / (la * lb) : 0.0;
  return pow(clamp(c * 0.5 + 0.5, 0.0, 1.0), uSkyShape.z * 2.0);
}

// Gradients are blended in a gamma-2 space: warm -> blue transitions stay luminous instead of
// passing through a muddy mauve (what a linear mix of orange and blue produces).
vec3 mixG(vec3 a, vec3 b, float t) {
  vec3 r = mix(sqrt(a), sqrt(b), t);
  return r * r;
}

vec3 hazeColor(vec3 dir) {
  return mixG(uSkyHaze, uSkyHazeSun, sunAzimuthWeight(dir)) * uSkyShape.w;
}

vec3 skyGradient(vec3 dir) {
  float up = clamp(dir.y, 0.0, 1.0);
  vec3 grad = mixG(uSkyHorizon, uSkyZenith, pow(up, uSkyShape.x)) * uSkyShape.w;
  float band = exp(-up / max(uSkyShape.y, 1e-3));
  return mixG(grad, hazeColor(dir), band);
}

vec3 sunGlow(vec3 dir) {
  float mu = max(dot(dir, uSunDir), 0.0);
  return uGlowColor * (uGlow.x * pow(mu, uGlow.y) + uGlow.z * pow(mu, uGlow.w));
}

vec3 atmosphereColor(vec3 dir) {
  return hazeColor(dir) + sunGlow(dir);
}

/** Lower hemisphere at infinity: haze at the horizon, then the cloud floor (env) / deep haze. */
vec3 belowHorizon(vec3 dir, vec3 floorColor) {
  float d = clamp(-dir.y, 0.0, 1.0);
  float k = smoothstep(0.0, 0.32, d);
  return mix(hazeColor(dir), floorColor, k) + sunGlow(dir) * mix(1.0, 0.5, k);
}

float fogAmount(vec3 camPos, vec3 dir, float dist) {
  float fd = uFogParams.x * dist;
  float od = fd * fd;
  float b = max(uFogParams.z, 1e-6);
  float k = uFogParams.y * exp(-b * (camPos.y - uFogParams.w));
  float ry = dir.y;
  od += abs(ry) > 1e-4 ? k * (1.0 - exp(-b * ry * dist)) / (b * ry) : k * dist;
  return 1.0 - exp(-od);
}

vec3 applyAerial(vec3 color, vec3 camPos, vec3 worldPos) {
  vec3 v = worldPos - camPos;
  float dist = length(v);
  vec3 dir = v / max(dist, 1e-3);
  return mix(color, atmosphereColor(dir), fogAmount(camPos, dir, dist));
}
`;
