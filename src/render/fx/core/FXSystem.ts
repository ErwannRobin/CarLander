/**
 * FXSystem — shared state for all game effects:
 *  - the procedural sprite atlas and the two shared particle pools
 *      smoke : premultiplied, depth-sorted, lit puffs (tire smoke, dust, exhaust trail, debris, gas puffs)
 *      glow  : additive (embers, sparks, sparkles, airflow motes, flashes)
 *  - the ring-wave decal pool and one shared "flash" point light (ignition, crash, perfect landing)
 *  - smoke lighting from the scene: key / fill lights (SceneLightProbe) + up to MAX_LOCAL_LIGHTS
 *    point / spot lights near the car (exhaust light, flash light, level floodlights), evaluated per
 *    particle in the smoke pool's vertex shader
 *  - per-theme look (core/theme.ts): emissive compensation, smoke shading floors
 *  - an ordered per-frame pipeline: simulate pools -> run registered effect ticks -> upload
 *  - the FX clock (sim-scaled: effects slow down in bullet-time and freeze when paused)
 *
 * Effects register a tick with `addTick` (see `useFXFrame`), so all spawning for a frame happens
 * between the simulate and upload phases regardless of React mount order. Transient state is
 * cleared through `reset()` — triggered by the 'reset' game event and, as a fallback, whenever
 * `runtime.runId` changes (effects subscribe with `onReset`, see `useFXReset`).
 */
import { type Camera, Color, type DataTexture, Group, PointLight, type Scene, type SpotLight, Vector3 } from 'three';
import type { QualityPreset } from '@/config/quality';
import type { RenderFrame, SimSnapshot, ThemeId } from '@/game/types';
import type { RGB } from './math';
import { damp } from './math';
import { MAX_LOCAL_LIGHTS, ParticlePool } from './ParticlePool';
import { RingWavePool } from './RingWavePool';
import { isLive, type LocalLight, SceneLightProbe } from './sceneLights';
import { createSpriteAtlas } from './spriteAtlas';
import { FX_THEMES } from './theme';

export interface FXFrameContext {
  readonly system: FXSystem;
  frame: RenderFrame;
  snapshot: SimSnapshot;
  camera: Camera;
  /** Effect delta: sim-scaled seconds (slow motion), 0 while paused. */
  dt: number;
  /** Unscaled frame delta (s), 0 while paused. */
  realDt: number;
  /** Accumulated effect clock (s). */
  time: number;
  /** Particle budget multiplier from the quality preset (0.4 .. 1). */
  quality: number;
  /** Theme multiplier for emissive (HDR) contributions (see core/theme.ts). */
  emissive: number;
  /** Theme the effects are rendered for. */
  theme: ThemeId;
}

export type FXTick = (ctx: FXFrameContext) => void;
export interface FXTickRef {
  current: FXTick;
}

/** Pool capacities at quality.particles = 1. */
const BASE_CAPACITY = { smoke: 2600, glow: 2200 } as const;

/** Render order for FX layers (after the opaque scene and default-order transparents). */
export const FX_ORDER = {
  decals: 2,
  smoke: 3,
  glow: 4,
  volumes: 5,
  markers: 6,
  overlay: 7,
} as const;

/** Share of the key light reaching the shadowed side of a puff (multiple scattering). */
const SMOKE_SCATTER = 0.35;
/**
 * Desaturation of the key light color for smoke: multiple scattering inside a puff whitens it, so a
 * low orange sun gives golden (not saturated orange) smoke.
 */
const SMOKE_KEY_DESAT = 0.3;
/** Upper bound of the shading multiplier (very bright suns are left to the tone mapper). */
const SMOKE_MAX = 3;

const _camPos = new Vector3();
const _targetLit = new Color();
const _targetDark = new Color();
const _dust = new Color();
const _key = new Color();
const _lp = new Vector3();
const _lt = new Vector3();

function isSpotLight(l: LocalLight): l is SpotLight {
  return (l as SpotLight).isSpotLight === true;
}

export class FXSystem {
  readonly root = new Group();
  readonly atlas: DataTexture;
  readonly smoke: ParticlePool;
  readonly glow: ParticlePool;
  readonly rings: RingWavePool;
  readonly flashLight: PointLight;
  /** Camera velocity (world, m/s of sim time) — reference for streak stretching. */
  readonly cameraVelocity = new Vector3();
  /** Unit world direction towards the key light (smoke shading). Override with setLightDirection. */
  readonly lightDirection = new Vector3(0.25, 1, 0.3).normalize();
  time = 0;
  /** Debug stats of the last frame (CPU time of the whole FX pipeline, live particle counts). */
  readonly stats = { cpuMs: 0, smoke: 0, glow: 0, lights: 0 };

  private qualityScale: number;
  // arrays (not Sets): iterated every frame with an index loop -> no iterator allocation
  private readonly ticks: FXTickRef[] = [];
  private readonly resetListeners: (() => void)[] = [];
  private lastRunId: number | null = null;
  private readonly ctx: FXFrameContext;
  private readonly prevCamPos = new Vector3();
  private hasPrevCam = false;
  /** Current smoke shading (linear multipliers) for the lit / shadowed side of a puff. */
  readonly shadeLit = new Color(1, 1, 1);
  readonly shadeDark = new Color(0.6, 0.63, 0.68);
  private shadeInit = false;
  private readonly probe = new SceneLightProbe();
  private lightDirOverride = false;
  private flashT = 1;
  private flashDur = 0.2;
  private flashPeak = 0;
  /** Theme emissive multiplier of the current frame (also applied to FX lights). */
  private emissive = 1;
  /** Lights owned by FX effects (never sampled twice as scene lights). */
  private readonly ownLights: LocalLight[] = [];
  private readonly isOwnLight = (l: LocalLight) => this.ownLights.includes(l);
  // local light selection scratch (fixed size, no per-frame allocation)
  private readonly pick: (LocalLight | null)[] = new Array(MAX_LOCAL_LIGHTS).fill(null);
  private readonly pickScore = new Float32Array(MAX_LOCAL_LIGHTS);

  constructor(quality: QualityPreset, frame: RenderFrame) {
    this.qualityScale = quality.particles;
    this.root.name = 'fx-root';
    this.atlas = createSpriteAtlas();
    this.smoke = new ParticlePool({
      name: 'smoke',
      capacity: BASE_CAPACITY.smoke * quality.particles,
      blending: 'premultiplied',
      texture: this.atlas,
      sort: true,
      renderOrder: FX_ORDER.smoke,
      nearFade: [0.6, 2.8],
      maxScreenSize: 0.9,
      cameraPull: 0.35,
      focusFade: true,
      shadeGlowSprites: true, // soft gas puffs (RCS, vacuum release) are lit, not emissive
      localLights: true,
    });
    this.glow = new ParticlePool({
      name: 'glow',
      capacity: BASE_CAPACITY.glow * quality.particles,
      blending: 'additive',
      texture: this.atlas,
      sort: false,
      renderOrder: FX_ORDER.glow,
      // sparks / embers flying at the chase camera dissolve before they streak across the lens
      nearFade: [0.8, 2.4],
      maxScreenSize: 0.6,
      // ...and stay thin streaks (≈ 4–7 px at 900p–1440p) instead of fat grains when they pass close
      streakMaxScreen: 0.0045,
    });
    this.rings = new RingWavePool(24, FX_ORDER.decals);
    // Lights stay in the scene permanently (intensity 0 when idle): toggling visibility would
    // change the light count and recompile every lit material.
    this.flashLight = new PointLight(0xffffff, 0, 30, 2);
    this.flashLight.name = 'fx-flash-light';
    this.flashLight.castShadow = false;
    this.ownLights.push(this.flashLight);

    this.root.add(this.smoke.mesh, this.glow.mesh, this.rings.mesh, this.flashLight);
    this.ctx = {
      system: this,
      frame,
      snapshot: frame.snapshot,
      camera: null as unknown as Camera,
      dt: 0,
      realDt: 0,
      time: 0,
      quality: quality.particles,
      emissive: 1,
      theme: 'morning',
    };
  }

  /** Registers an effect tick (called every frame between simulate and upload). Returns unregister. */
  addTick(ref: FXTickRef): () => void {
    this.ticks.push(ref);
    return () => {
      const i = this.ticks.indexOf(ref);
      if (i >= 0) this.ticks.splice(i, 1);
    };
  }

  /** Registers a callback run on every reset (restart). Returns unregister. */
  onReset(cb: () => void): () => void {
    this.resetListeners.push(cb);
    return () => {
      const i = this.resetListeners.indexOf(cb);
      if (i >= 0) this.resetListeners.splice(i, 1);
    };
  }

  /**
   * Declares a light owned by an effect (e.g. the exhaust light): it lights nearby smoke and is not
   * picked up again by the scene light scan. Returns unregister.
   */
  registerLight(light: LocalLight): () => void {
    if (!this.ownLights.includes(light)) this.ownLights.push(light);
    return () => {
      const i = this.ownLights.indexOf(light);
      if (i >= 0) this.ownLights.splice(i, 1);
    };
  }

  /**
   * Clears every transient effect and notifies effects (restart). `runId` (optional) records the
   * run this reset belongs to, so the runId fallback in `update` does not reset twice.
   */
  reset(runId?: number): void {
    if (runId !== undefined) this.lastRunId = runId;
    this.clear();
    for (let i = 0; i < this.resetListeners.length; i++) this.resetListeners[i]();
  }

  /**
   * Overrides the key-light direction used to shade smoke (unit vector towards the light). By
   * default the brightest shadow-casting DirectionalLight of the scene is tracked. Pass null to go
   * back to automatic tracking.
   */
  setLightDirection(dir: Vector3 | null): void {
    this.lightDirOverride = dir !== null;
    if (dir && dir.lengthSq() > 1e-8) this.lightDirection.copy(dir).normalize();
  }

  /** Re-budgets the pools (clears them). */
  setQuality(quality: QualityPreset): void {
    if (quality.particles === this.qualityScale) return;
    this.qualityScale = quality.particles;
    this.smoke.setCapacity(BASE_CAPACITY.smoke * quality.particles);
    this.glow.setCapacity(BASE_CAPACITY.glow * quality.particles);
    this.ctx.quality = quality.particles;
  }

  /**
   * Brief point-light flash (crash, ignition, perfect landing). `peak` is in candela for the
   * reference (morning) exposure; it is scaled by the theme's emissive factor. A new flash replaces
   * the current one only if it is brighter than what remains of it.
   */
  flash(position: Vector3, color: RGB, peak: number, duration: number): void {
    const remaining = this.flashPeak * Math.pow(Math.max(0, 1 - this.flashT), 2);
    const scaled = peak * this.emissive;
    if (scaled < remaining) return;
    this.flashLight.position.copy(position);
    this.flashLight.color.setRGB(color[0], color[1], color[2]);
    this.flashPeak = scaled;
    this.flashDur = Math.max(0.02, duration);
    this.flashT = 0;
  }

  /** One frame of the FX pipeline. Called by FXProvider inside useFrame (priority 0). */
  update(
    scene: Scene,
    camera: Camera,
    frame: RenderFrame,
    theme: ThemeId,
    quality: QualityPreset,
    runId: number,
    clock: number,
  ): void {
    const t0 = performance.now();
    if (this.lastRunId === null) this.lastRunId = runId;
    else if (runId !== this.lastRunId) this.reset(runId);
    this.setQuality(quality);
    const paused = frame.paused;
    const dt = paused ? 0 : Math.min(Math.max(frame.simDt, 0), 0.1);
    const realDt = paused ? 0 : Math.min(Math.max(frame.dt, 0), 0.1);
    this.time += dt;
    const look = FX_THEMES[theme] ?? FX_THEMES.morning;

    // camera velocity in sim time (reference frame for velocity-stretched streaks)
    camera.getWorldPosition(_camPos);
    if (this.hasPrevCam && dt > 1e-5) {
      const dx = _camPos.x - this.prevCamPos.x;
      const dy = _camPos.y - this.prevCamPos.y;
      const dz = _camPos.z - this.prevCamPos.z;
      if (dx * dx + dy * dy + dz * dz > 60 * 60) {
        this.cameraVelocity.set(0, 0, 0); // teleport / camera cut
      } else {
        const k = damp(18, realDt > 0 ? realDt : dt);
        this.cameraVelocity.x += (dx / dt - this.cameraVelocity.x) * k;
        this.cameraVelocity.y += (dy / dt - this.cameraVelocity.y) * k;
        this.cameraVelocity.z += (dz / dt - this.cameraVelocity.z) * k;
      }
    }
    this.prevCamPos.copy(_camPos);
    this.hasPrevCam = true;

    // smoke shading: sampled scene lights (Lambert-like, with scattering on the shadow side) with
    // a per-theme floor; theme fallback when the scene has no lights. Smoothed against flicker.
    this.probe.update(scene, clock, this.isOwnLight);
    if (!this.lightDirOverride && this.probe.hasKey) this.lightDirection.copy(this.probe.direction);
    this.computeSmokeShade(look);
    const ks = this.shadeInit ? Math.min(1, damp(3, Math.max(realDt, 1 / 120))) : 1;
    this.shadeInit = true;
    this.shadeLit.lerp(_targetLit, ks);
    this.shadeDark.lerp(_targetDark, ks);
    this.smoke.setLighting(this.lightDirection, this.shadeLit, this.shadeDark);
    _dust.copy(this.shadeLit).lerp(this.shadeDark, 0.35);
    this.rings.setDustTint(_dust);
    this.smoke.setFocus(frame.position, 2.6);
    this.emissive = look.emissive;
    this.glow.setEmissive(look.emissive);
    this.rings.setEmissive(look.emissive);

    // flash light envelope (before the local light selection: it is one of the candidates)
    if (this.flashT < 1) {
      this.flashT = Math.min(1, this.flashT + dt / this.flashDur);
      const k = 1 - this.flashT;
      this.flashLight.intensity = this.flashPeak * k * k;
    } else {
      this.flashLight.intensity = 0;
    }

    // simulate -> effect ticks (spawn) -> upload
    this.smoke.simulate(dt);
    this.glow.simulate(dt);
    const ctx = this.ctx;
    ctx.frame = frame;
    ctx.snapshot = frame.snapshot;
    ctx.camera = camera;
    ctx.dt = dt;
    ctx.realDt = realDt;
    ctx.time = this.time;
    ctx.quality = this.qualityScale;
    ctx.emissive = look.emissive;
    ctx.theme = theme;
    const ticks = this.ticks;
    for (let i = 0; i < ticks.length; i++) ticks[i].current(ctx);
    // effect ticks may have moved / dimmed their lights: select local lights last
    this.selectLocalLights(scene, frame.position);
    this.smoke.upload(camera, this.cameraVelocity);
    this.glow.upload(camera, this.cameraVelocity);
    this.rings.update(dt);

    this.stats.cpuMs = performance.now() - t0;
    this.stats.smoke = this.smoke.count;
    this.stats.glow = this.glow.count;
  }

  /** Target smoke shading into _targetLit / _targetDark. */
  private computeSmokeShade(look: (typeof FX_THEMES)[ThemeId]): void {
    const probe = this.probe;
    if (!probe.hasLights) {
      const f = look.smokeFallback;
      _targetLit.setRGB(f.lit[0], f.lit[1], f.lit[2]);
      _targetDark.setRGB(f.dark[0], f.dark[1], f.dark[2]);
      return;
    }
    const floor = look.smokeFloor;
    const sky = look.smokeSky;
    const k = _key.copy(probe.key);
    const lum = 0.2126 * k.r + 0.7152 * k.g + 0.0722 * k.b;
    k.r += (lum - k.r) * SMOKE_KEY_DESAT;
    k.g += (lum - k.g) * SMOKE_KEY_DESAT;
    k.b += (lum - k.b) * SMOKE_KEY_DESAT;
    const a = probe.fill;
    const invPi = 1 / Math.PI;
    // lit side: key + fill + part of the sky; shadow side: scattered key + fill + the whole sky
    _targetLit.setRGB(
      Math.min(SMOKE_MAX, Math.max(floor.lit[0], (k.r + a.r) * invPi + sky[0] * 0.5)),
      Math.min(SMOKE_MAX, Math.max(floor.lit[1], (k.g + a.g) * invPi + sky[1] * 0.5)),
      Math.min(SMOKE_MAX, Math.max(floor.lit[2], (k.b + a.b) * invPi + sky[2] * 0.5)),
    );
    _targetDark.setRGB(
      Math.min(SMOKE_MAX, Math.max(floor.dark[0], (k.r * SMOKE_SCATTER + a.r) * invPi + sky[0])),
      Math.min(SMOKE_MAX, Math.max(floor.dark[1], (k.g * SMOKE_SCATTER + a.g) * invPi + sky[1])),
      Math.min(SMOKE_MAX, Math.max(floor.dark[2], (k.b * SMOKE_SCATTER + a.b) * invPi + sky[2])),
    );
  }

  /**
   * Picks the MAX_LOCAL_LIGHTS most relevant point / spot lights for the smoke (score = intensity
   * over squared distance to the car) among the FX lights and the scene's, and uploads them.
   */
  private selectLocalLights(scene: Scene, focus: Vector3): void {
    this.pick.fill(null);
    this.pickScore.fill(0);
    for (let i = 0; i < this.ownLights.length; i++) this.considerLight(this.ownLights[i], scene, focus);
    const locals = this.probe.locals;
    for (let i = 0; i < locals.length; i++) this.considerLight(locals[i], scene, focus);

    let n = 0;
    for (let i = 0; i < MAX_LOCAL_LIGHTS; i++) {
      const l = this.pick[i];
      if (!l) break;
      l.getWorldPosition(_lp);
      if (isSpotLight(l)) {
        l.target.getWorldPosition(_lt);
        _lt.sub(_lp).normalize();
        this.smoke.setLocalLight(n, _lp, l.color, l.intensity, l.distance, l.decay, _lt, Math.cos(l.angle), Math.cos(l.angle * (1 - l.penumbra)));
      } else {
        this.smoke.setLocalLight(n, _lp, l.color, l.intensity, l.distance, l.decay, null, -2, -2);
      }
      n++;
    }
    this.smoke.setLocalLightCount(n);
    this.stats.lights = n;
  }

  /** Inserts `l` into the fixed-size top list if it is among the most relevant lights. */
  private considerLight(l: LocalLight, scene: Scene, focus: Vector3): void {
    if (l.intensity <= 0 || !isLive(l, scene)) return;
    l.getWorldPosition(_lp);
    const s = l.intensity / Math.max(1, _lp.distanceToSquared(focus));
    if (s < 1e-3) return;
    const pick = this.pick;
    const score = this.pickScore;
    for (let i = 0; i < MAX_LOCAL_LIGHTS; i++) {
      if (pick[i] === null || s > score[i]) {
        for (let j = MAX_LOCAL_LIGHTS - 1; j > i; j--) {
          pick[j] = pick[j - 1];
          score[j] = score[j - 1];
        }
        pick[i] = l;
        score[i] = s;
        return;
      }
    }
  }

  /** Clears the shared pools / decals / flash (use `reset` to also notify effects). */
  clear(): void {
    this.smoke.clear();
    this.glow.clear();
    this.rings.clear();
    this.flashT = 1;
    this.flashPeak = 0;
    this.flashLight.intensity = 0;
    this.cameraVelocity.set(0, 0, 0);
    this.hasPrevCam = false;
  }

  /**
   * Frees GPU resources. Safe under React StrictMode's simulated unmount/remount: three.js
   * re-uploads disposed geometries/textures if the objects are rendered again.
   */
  dispose(): void {
    // Ticks are unregistered by their owners' effect cleanups (keeps StrictMode remounts intact).
    this.smoke.dispose();
    this.glow.dispose();
    this.rings.dispose();
    this.atlas.dispose();
    this.flashLight.dispose();
  }
}
