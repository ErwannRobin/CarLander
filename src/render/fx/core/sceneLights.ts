/**
 * SceneLightProbe — samples the scene's lights so unlit FX (smoke billboards, dust decals) match the
 * lighting of the surrounding PBR materials, whatever lighting the env / level modules set up.
 *
 *  - key   : the brightest shadow-casting DirectionalLight (falls back to the brightest directional)
 *  - fill  : every HemisphereLight (weighted towards the sky color) and AmbientLight
 *  - local : PointLights / SpotLights (level floodlights, other modules' lights) — candidates for the
 *            per-particle local lighting of smoke (see FXSystem). Lights for which `exclude` returns
 *            true (the FX module's own lights) are skipped.
 *
 * Colors are linear and pre-multiplied by intensity. The scene is rescanned every couple of seconds
 * (lights come and go with theme / quality remounts); cached lights are validated every frame.
 */
import {
  type AmbientLight,
  Color,
  type DirectionalLight,
  type HemisphereLight,
  type Object3D,
  type PointLight,
  type Scene,
  type SpotLight,
  Vector3,
} from 'three';

const RESCAN_INTERVAL = 2;
/** Share of the hemisphere sky color seen by a smoke puff (it mostly sees the sky above). */
const HEMI_SKY_WEIGHT = 0.6;

const _a = new Vector3();
const _b = new Vector3();
const _c = new Color();

export type LocalLight = PointLight | SpotLight;

/** True when `o` and all its ancestors are visible and its root is `scene`. */
export function isLive(o: Object3D, scene: Scene): boolean {
  let p: Object3D | null = o;
  let root: Object3D = o;
  while (p) {
    if (!p.visible) return false;
    root = p;
    p = p.parent;
  }
  return root === scene;
}

export class SceneLightProbe {
  /** Key light color * intensity (black when no key light). */
  readonly key = new Color(0, 0, 0);
  /** Fill (hemisphere + ambient) color * intensity. */
  readonly fill = new Color(0, 0, 0);
  /** Unit world direction towards the key light (valid when `hasKey`). */
  readonly direction = new Vector3(0.25, 1, 0.3).normalize();
  hasKey = false;
  /** True when any key / fill light was found (otherwise callers should use their own fallback). */
  hasLights = false;
  /** Point / spot lights of the scene found by the last scan (validate with isLive before use). */
  readonly locals: LocalLight[] = [];

  private keyLight: DirectionalLight | null = null;
  private fills: (HemisphereLight | AmbientLight)[] = [];
  private nextScan = 0;

  /**
   * `time`: any monotonic clock in seconds (used to pace rescans). `exclude`: lights to ignore as
   * local lights (e.g. the FX module's own).
   */
  update(scene: Scene, time: number, exclude?: (light: LocalLight) => boolean): void {
    if (time >= this.nextScan || time < this.nextScan - RESCAN_INTERVAL * 2) {
      this.scan(scene, exclude);
      this.nextScan = time + RESCAN_INTERVAL;
    }

    this.key.setRGB(0, 0, 0);
    this.hasKey = false;
    const k = this.keyLight;
    if (k && isLive(k, scene)) {
      this.key.copy(k.color).multiplyScalar(k.intensity);
      k.getWorldPosition(_a);
      k.target.getWorldPosition(_b);
      _a.sub(_b);
      if (_a.lengthSq() > 1e-8) {
        this.direction.copy(_a).normalize();
        this.hasKey = true;
      }
    }

    this.fill.setRGB(0, 0, 0);
    let anyFill = false;
    for (let i = 0; i < this.fills.length; i++) {
      const l = this.fills[i];
      if (!isLive(l, scene)) continue;
      anyFill = true;
      if ((l as HemisphereLight).isHemisphereLight) {
        const h = l as HemisphereLight;
        _c.lerpColors(h.groundColor, h.color, HEMI_SKY_WEIGHT).multiplyScalar(h.intensity);
      } else {
        _c.copy(l.color).multiplyScalar(l.intensity);
      }
      this.fill.add(_c);
    }
    this.hasLights = this.hasKey || anyFill;
  }

  private scan(scene: Scene, exclude?: (light: LocalLight) => boolean): void {
    let best: DirectionalLight | null = null;
    let bestScore = -1;
    const fills: (HemisphereLight | AmbientLight)[] = [];
    this.locals.length = 0;
    scene.traverse((o) => {
      if ((o as DirectionalLight).isDirectionalLight) {
        const l = o as DirectionalLight;
        const score = l.intensity * (l.castShadow ? 1000 : 1);
        if (score > bestScore) {
          bestScore = score;
          best = l;
        }
      } else if ((o as HemisphereLight).isHemisphereLight || (o as AmbientLight).isAmbientLight) {
        fills.push(o as HemisphereLight | AmbientLight);
      } else if ((o as PointLight).isPointLight || (o as SpotLight).isSpotLight) {
        const l = o as LocalLight;
        if (!exclude || !exclude(l)) this.locals.push(l);
      }
    });
    this.keyLight = best;
    this.fills = fills;
  }
}
