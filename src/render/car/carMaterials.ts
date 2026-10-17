/**
 * Per-instance car materials. Geometry is shared between instances (see carAssets.ts); materials
 * are cheap and carry per-instance state (paint colour, light / boost / vacuum intensities).
 * three's program cache shares the compiled shaders between instances.
 */
import {
  AdditiveBlending,
  Color,
  type ColorRepresentation,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type Material,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import type { QualityLevel } from '@/game/types';
import { PALETTE } from '@/render/palette';
import { rcsPortSurface } from './geometry/details';

export interface CarMaterials {
  paint: MeshPhysicalMaterial;
  trim: MeshPhysicalMaterial;
  glass: MeshPhysicalMaterial;
  titanium: MeshPhysicalMaterial;
  lightFront: MeshStandardMaterial;
  lightRear: MeshStandardMaterial;
  throat: MeshBasicMaterial;
  vacuum: MeshStandardMaterial;
  tire: MeshStandardMaterial;
  rim: MeshPhysicalMaterial;
  /** One per wheel (opacity is driven by each wheel's spin rate). */
  blur: MeshStandardMaterial[];
}

/**
 * Emissive intensities (HDR). Front bar, brake, nozzle throats and vacuum grille exceed the bloom
 * thresholds (0.85-1.3 across the themes). The running rear bar deliberately sits just below them:
 * AgX rolls a bright saturated red off towards coral, so 0.85 keeps it reading red, and braking
 * (5.5, ~6.5x) blooms clearly.
 */
export const LIGHT_LEVELS = {
  front: 6.5,
  rearRunning: 0.85,
  rearBrake: 5.5,
  throatMax: 7,
  vacuumIdle: 0.04,
  vacuumMax: 4.2,
} as const;

/** Radius of the dark RCS vent disc on the paint (tucks under the titanium rim's inner lip). */
const RCS_VENT_R = 0.0119;

/** GLSL array of the RCS vent centres on the body surface (chassis space). */
function rcsVentGlsl(): string {
  const ports = rcsPortSurface();
  const f = (v: number) => v.toFixed(5);
  const list = ports.map((p) => `vec3(${f(p.position[0])}, ${f(p.position[1])}, ${f(p.position[2])})`).join(',\n  ');
  return `const int CAR_RCS_N = ${ports.length};
const vec3 CAR_RCS_P[${ports.length}] = vec3[${ports.length}](
  ${list}
);`;
}

/**
 * Paint shader hook: thin anti-aliased panel shut lines (doors + frunk lid) and the dark RCS vent
 * openings, drawn analytically from the chassis-space position, so they cost no geometry and stay
 * razor sharp at any distance.
 */
function installShutLines(mat: MeshPhysicalMaterial): void {
  const vents = rcsVentGlsl();
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCarPos;\nvarying vec3 vCarNrm;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCarPos = position;\nvCarNrm = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vCarPos;
varying vec3 vCarNrm;
float carLine(float d, float w) {
  float aa = max(fwidth(d), 1e-5) * 1.1;
  return 1.0 - smoothstep(w - aa, w + aa, abs(d));
}
float carShutLines() {
  vec3 p = vCarPos;
  vec3 n = normalize(vCarNrm);
  float m = 0.0;
  // door cuts on the flanks
  if (abs(p.x) > 0.5 && p.y < 0.425 && abs(n.x) > 0.28) {
    float dFront = p.z - (-0.835 - 0.12 * (p.y + 0.06));
    float dRear = p.z - (0.43 + 0.22 * max(p.y, 0.0));
    m = max(m, carLine(dFront, 0.0017));
    m = max(m, carLine(dRear, 0.0017) * step(-0.08, p.y));
    // flush door handle: small rounded slot near the upper rear of the door
    vec2 hq = abs(vec2(p.z - 0.21, p.y - 0.255)) - vec2(0.05, 0.007);
    float hd = length(max(hq, 0.0)) + min(max(hq.x, hq.y), 0.0) - 0.006;
    m = max(m, carLine(hd, 0.0012));
  }
  // frunk lid: U shape on the hood
  if (n.y > 0.45 && p.z < -1.0 && p.z > -2.2) {
    float side = abs(p.x) - (0.47 - 0.05 * smoothstep(-1.4, -2.15, p.z));
    float back = p.z + 1.04;
    float inU = step(abs(p.x), 0.47);
    m = max(m, carLine(side, 0.0016) * step(p.z, -1.04));
    m = max(m, carLine(back, 0.0016) * inU);
  }
  return m;
}
${vents}
// RCS vent openings: dark discs inside the titanium rims (the corner ports live at |z| > 1.8)
float carVents() {
  if (abs(vCarPos.z) < 1.8) return 0.0;
  float m = 0.0;
  for (int i = 0; i < CAR_RCS_N; i++) {
    float d = length(vCarPos - CAR_RCS_P[i]) - ${RCS_VENT_R.toFixed(4)};
    float aa = max(fwidth(d), 1e-5);
    m = max(m, 1.0 - smoothstep(-aa, aa, d));
  }
  return m;
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float carCut = carShutLines();
float carVent = carVents();
diffuseColor.rgb *= (1.0 - 0.82 * carCut) * (1.0 - 0.94 * carVent);
carCut = max(carCut, carVent);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.85, carCut);`,
      )
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
material.clearcoat *= 1.0 - carCut;`,
      );
  };
  // distinct cache key so the patched program is not shared with plain physical materials
  mat.customProgramCacheKey = () => 'roadster-paint-v2';
}

/**
 * Glass shader hook: matte black frame lines (A-pillars flowing into the roof rails) on the
 * canopy. The line follows the canopy where its surface turns from the windshield / roof to the
 * side glass (|normal.x| ~ 0.6), so it tracks any future change of the canopy shape for free.
 */
function installCanopyFrames(mat: MeshPhysicalMaterial): void {
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCarPos;\nvarying vec3 vCarNrm;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCarPos = position;\nvCarNrm = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vCarPos;
varying vec3 vCarNrm;
float canopyFrame() {
  vec3 p = vCarPos;
  // canopy footprint only (excludes light housings, mirror glass and the tail panel)
  if (abs(p.x) > 0.73 || p.y < 0.4 || p.z < -0.9 || p.z > 2.0) return 0.0;
  vec3 n = normalize(vCarNrm);
  float d = abs(n.x) - 0.62;
  float aa = max(fwidth(d), 1e-4) * 1.2;
  float band = 1.0 - smoothstep(0.075 - aa, 0.075 + aa, abs(d));
  // fade the line out where the canopy dives into the cowl / deck
  band *= smoothstep(-0.9, -0.78, p.z) * (1.0 - smoothstep(1.75, 1.98, p.z));
  return band;
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
float carFrame = canopyFrame();
roughnessFactor = mix(roughnessFactor, 0.6, carFrame);`,
      )
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
material.specularColor *= 1.0 - 0.85 * carFrame;
material.specularColorBlended *= 1.0 - 0.85 * carFrame;
material.specularF90 *= 1.0 - 0.85 * carFrame;`,
      );
  };
  mat.customProgramCacheKey = () => 'roadster-glass-v1';
}

/**
 * @param quality 'low' drops the pearl iridescence, the sheen and the secondary clear coats (trim,
 *   titanium, rims): the paint keeps its main clear coat, which carries most of the look.
 */
export function createCarMaterials(paint: ColorRepresentation = PALETTE.paint, quality: QualityLevel = 'high'): CarMaterials {
  const rich = quality !== 'low';
  const paintMat = new MeshPhysicalMaterial({
    name: 'car-paint',
    color: new Color(paint),
    metalness: 0.22,
    roughness: 0.3,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    sheen: rich ? 0.25 : 0,
    sheenRoughness: 0.5,
    sheenColor: new Color('#dfe9ff'),
    // faint thin-film shift at grazing angles reads as pearl
    iridescence: rich ? 0.18 : 0,
    iridescenceIOR: 1.35,
    iridescenceThicknessRange: [180, 420],
  });
  installShutLines(paintMat);

  const trim = new MeshPhysicalMaterial({
    name: 'car-trim',
    color: PALETTE.trimBlack,
    metalness: 0.2,
    roughness: 0.52,
    clearcoat: rich ? 0.3 : 0,
    clearcoatRoughness: 0.35,
  });
  const glass = new MeshPhysicalMaterial({
    name: 'car-glass',
    color: '#06090d',
    metalness: 0.0,
    roughness: 0.02,
    ior: 1.52,
    specularIntensity: 1,
    envMapIntensity: 0.9,
  });
  installCanopyFrames(glass);
  const titanium = new MeshPhysicalMaterial({
    name: 'car-titanium',
    color: '#ffffff',
    vertexColors: true,
    metalness: 1,
    roughness: 0.27,
    clearcoat: rich ? 0.3 : 0,
    clearcoatRoughness: 0.2,
  });
  const lightFront = new MeshStandardMaterial({
    name: 'car-light-front',
    color: '#0b0d10',
    emissive: '#e8f4ff',
    emissiveIntensity: LIGHT_LEVELS.front,
    roughness: 0.18,
    metalness: 0,
  });
  const lightRear = new MeshStandardMaterial({
    name: 'car-light-rear',
    color: '#140507',
    emissive: '#ff0c22',
    emissiveIntensity: LIGHT_LEVELS.rearRunning,
    roughness: 0.22,
    metalness: 0,
  });
  const throat = new MeshBasicMaterial({
    name: 'car-throat',
    vertexColors: true,
    color: new Color(0, 0, 0),
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
  const vacuum = new MeshStandardMaterial({
    name: 'car-vacuum',
    color: '#0a1013',
    emissive: PALETTE.cyan,
    emissiveIntensity: LIGHT_LEVELS.vacuumIdle,
    roughness: 0.35,
    metalness: 0.2,
  });
  const tire = new MeshStandardMaterial({
    name: 'car-tire',
    color: '#151619',
    roughness: 0.8,
    metalness: 0,
  });
  const rim = new MeshPhysicalMaterial({
    name: 'car-rim',
    color: '#ffffff',
    vertexColors: true,
    metalness: 0.88,
    roughness: 0.3,
    clearcoat: rich ? 0.55 : 0,
    clearcoatRoughness: 0.12,
  });
  const blur: MeshStandardMaterial[] = [];
  for (let i = 0; i < 4; i++) {
    blur.push(
      new MeshStandardMaterial({
        name: `car-wheel-blur-${i}`,
        color: '#23282e',
        metalness: 0.8,
        roughness: 0.36,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
  }
  return { paint: paintMat, trim, glass, titanium, lightFront, lightRear, throat, vacuum, tire, rim, blur };
}

export function disposeCarMaterials(m: CarMaterials): void {
  const all: Material[] = [m.paint, m.trim, m.glass, m.titanium, m.lightFront, m.lightRear, m.throat, m.vacuum, m.tire, m.rim, ...m.blur];
  for (const mat of all) mat.dispose();
}
