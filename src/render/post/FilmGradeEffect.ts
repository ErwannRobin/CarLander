import { BlendFunction, Effect } from 'postprocessing';
import { Color, SRGBColorSpace, Uniform, Vector3 } from 'three';
import type { ThemeDef } from '@/render/env/themes';

/**
 * Exposure + tone mapping + finishing grade in one pass (the renderer runs with tone mapping off).
 *
 *  1. exposure (scene-referred, linear)
 *  2. AgX (three.js / Filament constants) with an ASC-CDL "look" applied in AgX log space —
 *     a slightly punchy look that keeps the graphite/titanium neutrals clean while warm sunlight
 *     and the cyan accents stay saturated; or ACES filmic as an alternative.
 *  3. display-space finishing: split toning, contrast, saturation, black lift
 *  4. triangular dither (kills banding in sky gradients / night fog), then back to linear for the
 *     composer's sRGB output encode.
 */
const FRAGMENT = /* glsl */ `
uniform float exposure;
uniform vec3 lookSlope;
uniform float lookPower;
uniform float lookSat;
uniform float contrast;
uniform float saturation;
uniform vec3 shadowTint;
uniform vec3 highlightTint;
uniform float lift;

#ifndef GRADE_TONEMAP
#define GRADE_TONEMAP 0
#endif

const mat3 GRADE_REC2020_TO_SRGB = mat3(
  vec3(1.6605, -0.1246, -0.0182),
  vec3(-0.5876, 1.1329, -0.1006),
  vec3(-0.0728, -0.0083, 1.1187)
);
const mat3 GRADE_SRGB_TO_REC2020 = mat3(
  vec3(0.6274, 0.0691, 0.0164),
  vec3(0.3293, 0.9195, 0.0880),
  vec3(0.0433, 0.0113, 0.8956)
);

vec3 gradeAgxContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

vec3 gradeAgx(vec3 color) {
  const mat3 inset = mat3(
    vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
    vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
    vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859)
  );
  const mat3 outset = mat3(
    vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
    vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
    vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405)
  );
  const float minEv = -12.47393;
  const float maxEv = 4.026069;
  color = GRADE_SRGB_TO_REC2020 * color;
  color = inset * color;
  color = max(color, 1e-10);
  color = clamp((log2(color) - minEv) / (maxEv - minEv), 0.0, 1.0);
  color = gradeAgxContrast(color);
  // look (Filament): slope / power / saturation around Rec.709 luma
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = pow(max(color * lookSlope, 0.0), vec3(lookPower));
  color = luma + lookSat * (color - luma);
  color = outset * color;
  color = pow(max(color, 0.0), vec3(2.2));
  color = GRADE_REC2020_TO_SRGB * color;
  return clamp(color, 0.0, 1.0);
}

vec3 gradeAces(vec3 color) {
  const mat3 inMat = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777)
  );
  const mat3 outMat = mat3(
    vec3(1.60475, -0.10208, -0.00327),
    vec3(-0.53108, 1.10813, -0.07276),
    vec3(-0.07367, -0.00605, 1.07602)
  );
  color = inMat * (color / 0.6);
  vec3 a = color * (color + 0.0245786) - 0.000090537;
  vec3 b = color * (0.983729 * color + 0.4329510) + 0.238081;
  color = outMat * (a / b);
  return clamp(color, 0.0, 1.0);
}

float gradeIgn(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = max(inputColor.rgb, 0.0) * exposure;
#if GRADE_TONEMAP == 1
  c = gradeAces(c);
#else
  c = gradeAgx(c);
#endif
  // finishing in a perceptual (gamma 2.2) space
  vec3 g = pow(c, vec3(1.0 / 2.2));
  float l = dot(g, vec3(0.2126, 0.7152, 0.0722));
  float ws = 1.0 - smoothstep(0.0, 0.55, l);
  float wh = smoothstep(0.45, 1.0, l);
  g += shadowTint * ws + highlightTint * wh;
  g = (g - 0.5) * contrast + 0.5;
  float l2 = dot(g, vec3(0.2126, 0.7152, 0.0722));
  g = mix(vec3(l2), g, saturation);
  g = g * (1.0 - lift) + lift;
  // triangular dither, +-1/255 peak
  float n = gradeIgn(gl_FragCoord.xy) + gradeIgn(gl_FragCoord.xy + vec2(37.0, 17.0)) - 1.0;
  g += n / 255.0;
  outputColor = vec4(pow(clamp(g, 0.0, 1.0), vec3(2.2)), inputColor.a);
}
`;

const _srgb = new Color();
const _lin = new Color();

/** Chroma offset of a tint (sRGB space, luminance removed), scaled. */
function tintOffset(hex: string, amount: number, out: Vector3): Vector3 {
  _lin.set(hex);
  _srgb.copy(_lin);
  const rgb = { r: 0, g: 0, b: 0 };
  _srgb.getRGB(rgb, SRGBColorSpace);
  const l = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
  return out.set((rgb.r - l) * amount, (rgb.g - l) * amount, (rgb.b - l) * amount);
}

export class FilmGradeEffect extends Effect {
  private toneMapping: 'agx' | 'aces' = 'agx';

  constructor() {
    super('FilmGradeEffect', FRAGMENT, {
      blendFunction: BlendFunction.SRC,
      defines: new Map([['GRADE_TONEMAP', '0']]),
      uniforms: new Map<string, Uniform>([
        ['exposure', new Uniform(1)],
        ['lookSlope', new Uniform(new Vector3(1, 1, 1))],
        ['lookPower', new Uniform(1)],
        ['lookSat', new Uniform(1)],
        ['contrast', new Uniform(1)],
        ['saturation', new Uniform(1)],
        ['shadowTint', new Uniform(new Vector3())],
        ['highlightTint', new Uniform(new Vector3())],
        ['lift', new Uniform(0)],
      ]),
    });
  }

  get exposure(): number {
    return this.uniforms.get('exposure')!.value as number;
  }
  set exposure(v: number) {
    this.uniforms.get('exposure')!.value = v;
  }

  /** Applies a theme's exposure + grade. Changing the operator recompiles; everything else is uniforms. */
  setTheme(theme: ThemeDef): void {
    const g = theme.grade;
    const u = this.uniforms;
    u.get('exposure')!.value = theme.exposure;
    (u.get('lookSlope')!.value as Vector3).set(g.look.slope[0], g.look.slope[1], g.look.slope[2]);
    u.get('lookPower')!.value = g.look.power;
    u.get('lookSat')!.value = g.look.saturation;
    u.get('contrast')!.value = g.contrast;
    u.get('saturation')!.value = g.saturation;
    tintOffset(g.shadows, g.split, u.get('shadowTint')!.value as Vector3);
    tintOffset(g.highlights, g.split, u.get('highlightTint')!.value as Vector3);
    u.get('lift')!.value = g.lift;
    if (g.toneMapping !== this.toneMapping) {
      this.toneMapping = g.toneMapping;
      this.defines.set('GRADE_TONEMAP', g.toneMapping === 'aces' ? '1' : '0');
      this.setChanged();
    }
  }
}
