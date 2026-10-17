import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';
import { Uniform, Vector2 } from 'three';

/**
 * High-speed treatment, restrained:
 *  - radial blur toward the focus of expansion (the projected velocity direction), masked so the
 *    center of the frame (the car) stays crisp; some angular sectors smear more, which reads as
 *    speed streaks rather than a uniform zoom blur;
 *  - very subtle chromatic dispersion inside that smear (red weights the samples nearest the pixel,
 *    blue the farthest): a soft lateral-CA fringe that only exists where the image is already
 *    smeared, so it can never produce sharp coloured edges;
 *  - faint light streaks travelling outward at the periphery.
 * Convolution effect (samples the input buffer); everything early-outs when idle.
 */
const FRAGMENT = /* glsl */ `
uniform vec2 center;
uniform float amount;
uniform float streaks;
uniform float aberration;
uniform float phase;

#ifndef SPEED_SAMPLES
#define SPEED_SAMPLES 10
#endif

float speedHash(float n) {
  return fract(sin(n * 127.1) * 43758.5453);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  if (amount <= 0.0) {
    outputColor = inputColor;
    return;
  }
  vec2 asp = vec2(aspect, 1.0);
  vec2 d = uv - center;
  vec2 da = d * asp;
  float r = length(da);
  float mask = smoothstep(0.2, 0.85, r);
  vec3 col = inputColor.rgb;

  float ang = atan(da.y, da.x);
  const float SECTORS = 72.0;
  float sa = ang * (SECTORS / 6.2831853);
  float sector = floor(sa);
  float rnd = speedHash(sector + 17.0);

  if (mask > 0.0) {
    // per-sector smear length (smoothly varying across sectors)
    float rndNext = speedHash(sector + 18.0);
    float s = mix(rnd, rndNext, smoothstep(0.0, 1.0, fract(sa)));
    float len = amount * mask * (0.45 + 0.9 * s * s) * 0.075;
    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    // spectral weights along the smear (normalized per channel: flat areas keep their colour)
    float disp = clamp(aberration * mask, 0.0, 1.0);
    vec3 acc = vec3(0.0);
    vec3 wsum = vec3(0.0);
    for (int i = 0; i < SPEED_SAMPLES; i++) {
      float t = (float(i) + jitter) / float(SPEED_SAMPLES);
      vec3 w = mix(vec3(1.0), vec3(1.0 - t, 1.0 - abs(2.0 * t - 1.0), t) * 2.0, disp) + 1e-3;
      acc += texture2D(inputBuffer, uv - d * len * t).rgb * w;
      wsum += w;
    }
    col = acc / wsum;
  }

  if (streaks > 0.0 && rnd > 0.72) {
    // a thin light streak per selected sector, travelling outward
    float spd = 0.6 + speedHash(sector + 3.0) * 1.2;
    float head = fract(phase * spd + speedHash(sector + 9.0));
    float rh = mix(0.3, 1.25, head);
    float along = smoothstep(rh - 0.22, rh, r) * (1.0 - smoothstep(rh, rh + 0.02, r));
    float lineOff = (fract(sa) - 0.5 - (speedHash(sector + 5.0) - 0.5) * 0.6) * (6.2831853 / SECTORS) * r;
    float width = 0.0011 + 0.0012 * r;
    float line = 1.0 - smoothstep(width * 0.3, width, abs(lineOff));
    float fade = smoothstep(0.35, 0.8, r);
    col += vec3(1.0, 0.98, 0.95) * line * along * fade * streaks * 0.1;
  }

  outputColor = vec4(col, inputColor.a);
}
`;

export class SpeedFXEffect extends Effect {
  constructor({ samples = 10 }: { samples?: number } = {}) {
    super('SpeedFXEffect', FRAGMENT, {
      attributes: EffectAttribute.CONVOLUTION,
      blendFunction: BlendFunction.NORMAL,
      defines: new Map([['SPEED_SAMPLES', String(Math.max(2, Math.round(samples)))]]),
      uniforms: new Map<string, Uniform>([
        ['center', new Uniform(new Vector2(0.5, 0.5))],
        ['amount', new Uniform(0)],
        ['streaks', new Uniform(0)],
        ['aberration', new Uniform(0)],
        ['phase', new Uniform(0)],
      ]),
    });
  }

  /** Focus of expansion in uv. */
  get center(): Vector2 {
    return this.uniforms.get('center')!.value as Vector2;
  }
  /** Radial blur amount 0..1 (0 disables the whole effect). */
  get amount(): number {
    return this.uniforms.get('amount')!.value as number;
  }
  set amount(v: number) {
    this.uniforms.get('amount')!.value = v;
  }
  /** Peripheral streak intensity 0..1. */
  get streaks(): number {
    return this.uniforms.get('streaks')!.value as number;
  }
  set streaks(v: number) {
    this.uniforms.get('streaks')!.value = v;
  }
  /** Chromatic dispersion of the radial smear, 0..1 (only visible where `amount` blurs). */
  get aberration(): number {
    return this.uniforms.get('aberration')!.value as number;
  }
  set aberration(v: number) {
    this.uniforms.get('aberration')!.value = v;
  }
  /** Streak animation phase (seconds, wrapped by the caller). */
  get phase(): number {
    return this.uniforms.get('phase')!.value as number;
  }
  set phase(v: number) {
    this.uniforms.get('phase')!.value = v;
  }
}
