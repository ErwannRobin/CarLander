/**
 * Shared plumbing for architecture-kit components: transform props, build-and-dispose hook,
 * seeded value noise, glow sprite texture and the real-light budget.
 */
import { useEffect, useMemo, useState, type DependencyList } from 'react';
import { CanvasTexture, Color, Mesh, MeshBasicMaterial, type BufferGeometry, type Material, type Object3D } from 'three';
import { runtime } from '@/game/runtime';
import type { V3 } from '@/game/types';
import { getLevelMaterials, LED_TINTS, onLevelMaterialsDispose, type LedColor } from '../materials';
import { createCanvas, makeTexture } from '../textures/canvasUtils';
import type { GeoBuilder } from '../geometry/GeoBuilder';

/** Common transform props accepted by every kit component (applied to its root group). */
export interface KitTransform {
  position?: V3;
  /** Euler XYZ in radians. */
  rotation?: V3;
  scale?: number | V3;
  name?: string;
}

/** Anything with GPU resources to release. */
export interface Disposable {
  dispose(): void;
}

/**
 * Builds three objects once per `deps` change and disposes the previous build's resources.
 * The builder returns the root object plus the disposables it owns (never shared materials).
 * Disposal releases GPU memory only; three re-uploads if a StrictMode re-mount renders it again.
 */
export function useKitBuild<T extends { root: Object3D; owned: Disposable[] }>(build: () => T, deps: DependencyList): T {
  // deps are supplied by the caller (value-compared props); `build` itself is a fresh closure
  const built = useMemo(build, deps);
  useEffect(
    () => () => {
      for (const d of built.owned) d.dispose();
    },
    [built],
  );
  return built;
}

/** Wraps a builder into a Mesh with standard shadow flags; registers the geometry as owned. */
export function meshFrom(b: GeoBuilder, material: Material, owned: Disposable[], shadows: { cast?: boolean; receive?: boolean } = {}): Mesh | null {
  if (b.isEmpty()) return null;
  const geo: BufferGeometry = b.build();
  owned.push(geo);
  const mesh = new Mesh(geo, material);
  mesh.castShadow = shadows.cast ?? true;
  mesh.receiveShadow = shadows.receive ?? true;
  return mesh;
}

/** Emissive material for an LED color key or any CSS color (custom colors are owned by the caller). */
export function ledMaterial(color: LedColor | string, dotted: boolean, owned: Disposable[], intensity = 1): MeshBasicMaterial {
  const lib = getLevelMaterials();
  if (color in LED_TINTS && intensity === 1) return dotted ? lib.led[color as LedColor] : lib.glow[color as LedColor];
  const base = color in LED_TINTS ? LED_TINTS[color as LedColor] : { hex: color, intensity: 3 };
  const mat = new MeshBasicMaterial({
    color: new Color(base.hex).multiplyScalar(base.intensity * intensity),
    map: dotted ? lib.led.cyan.map : null,
    toneMapped: false,
  });
  owned.push(mat);
  return mat;
}

/* ------------------------------------------------------------------ */
/* Seeded value noise (non-tileable, for geometry displacement)        */
/* ------------------------------------------------------------------ */

export class ValueNoise {
  private perm: Uint8Array;
  private vals: Float32Array;
  constructor(seed = 1) {
    let a = seed >>> 0 || 1;
    const rnd = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    this.perm = new Uint8Array(512);
    this.vals = new Float32Array(256);
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    for (let i = 0; i < 256; i++) this.vals[i] = rnd() * 2 - 1;
  }
  /** Smooth 2D value noise in [-1, 1]. */
  noise2(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const tx = x - xi;
    const ty = y - yi;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const p = this.perm;
    const v = this.vals;
    const X = xi & 255;
    const Y = yi & 255;
    const a = v[p[p[X] + Y]];
    const b = v[p[p[X + 1] + Y]];
    const c = v[p[p[X] + Y + 1]];
    const d = v[p[p[X + 1] + Y + 1]];
    const top = a + (b - a) * sx;
    const bot = c + (d - c) * sx;
    return top + (bot - top) * sy;
  }
  /** Fractal sum, roughly in [-1, 1]. */
  fbm2(x: number, y: number, octaves = 4, gain = 0.5, lacunarity = 2.03): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += this.noise2(x * freq + o * 17.1, y * freq - o * 9.7) * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }
}

/* ------------------------------------------------------------------ */
/* Glow sprite texture                                                  */
/* ------------------------------------------------------------------ */

let glowTex: CanvasTexture | null = null;
/** Soft radial glow (additive sprites around lamps). Cached. */
export function getGlowTexture(): CanvasTexture {
  if (!glowTex) {
    const { canvas, ctx } = createCanvas(128, 128);
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.12, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.14)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    glowTex = makeTexture(canvas, { color: true, repeat: false, flipY: true });
  }
  return glowTex;
}

// part of the module-wide teardown (disposeLevelMaterials)
onLevelMaterialsDispose(() => {
  glowTex?.dispose();
  glowTex = null;
});

/* ------------------------------------------------------------------ */
/* Real light budget                                                    */
/* ------------------------------------------------------------------ */

const holders = new Set<symbol>();

/** Max simultaneous real SpotLights created by kit components for the current quality preset. */
export function kitLightBudget(): number {
  const q = runtime.quality.level;
  return q === 'high' ? 6 : q === 'medium' ? 3 : 0;
}

/**
 * Requests one real-light slot. Returns true once granted (re-renders once); releases on unmount.
 * Slots are first come, first served — prefer requesting lights only on hero fixtures.
 */
export function useLightSlot(requested: boolean): boolean {
  const [granted, setGranted] = useState(false);
  useEffect(() => {
    if (!requested) return;
    const id = Symbol('kit-light');
    if (holders.size >= kitLightBudget()) return;
    holders.add(id);
    setGranted(true);
    return () => {
      holders.delete(id);
      setGranted(false);
    };
  }, [requested]);
  return granted;
}
