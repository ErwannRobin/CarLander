/**
 * Art-directed lighting / atmosphere themes.
 *
 * Colors are authored as sRGB hex (converted to linear by three's color management); every
 * "intensity" is a linear HDR multiplier. The renderer runs tone mapping in the PostFX stack, so
 * values above 1 are expected (sun disk, glows) and only very bright emissives should cross the
 * bloom threshold.
 *
 * Direction convention (`azimuthDeg`): 0 = toward -Z (the direction levels progress), +90 = toward
 * +X (right of the runway), 180 = behind (+Z). `elevationDeg` above the horizon.
 */
import { Vector3 } from 'three';
import type { ThemeId } from '@/game/types';

export type RGB = [number, number, number];

/** An emissive card rendered only into the reflection environment (studio highlights). */
export interface LightformerDef {
  /** Direction toward the card (elevation / azimuth, degrees) and its distance from the origin. */
  elevationDeg: number;
  azimuthDeg: number;
  distance: number;
  /** Card size in meters (width, height) at that distance. */
  size: [number, number];
  color: string;
  intensity: number;
  shape?: 'rect' | 'disc';
}

export interface ThemeDef {
  id: ThemeId;
  name: string;

  /** Sun position in the sky: drives the visible disk, the glow, the afterglow and (unless `keyLight` is set) the shadow-casting light. */
  sun: {
    elevationDeg: number;
    azimuthDeg: number;
    color: string;
    /** Directional light intensity (three.js units: lit white = albedo * I / PI). */
    intensity: number;
    /** Visible sun disk (angular radius in degrees, HDR radiance). null = hidden (below horizon / night). */
    disk: { size: number; intensity: number } | null;
  };
  /** Shadow-casting key light override (night: moonlight while the sun sits below the horizon). */
  keyLight?: { elevationDeg: number; azimuthDeg: number; color: string; intensity: number };
  shadow: { intensity: number; radius: number };

  sky: {
    zenith: string;
    horizon: string;
    /** Horizon haze looking away from the sun. Also what distant geometry fades into. */
    haze: string;
    /** Horizon haze toward the sun azimuth (forward scattering, golden glow, night afterglow). */
    hazeSun: string;
    /** Deep color under the cloud sea (seen through gaps / straight down at infinity). */
    below: string;
    /** HDR multiplier on the whole gradient. */
    intensity: number;
    /** Gradient exponent: > 1 keeps the horizon color higher up the dome. */
    curve: number;
    /** Haze band thickness (in sin(elevation) units). */
    hazeHeight: number;
    /** Azimuthal focus of `hazeSun` (higher = narrower warm sector). */
    sunFocus: number;
    /** Mie-like glow around the sun: tight core + wide halo. */
    glow: { color: string; tight: number; tightPower: number; wide: number; widePower: number };
    /** High cirrus deck. */
    cirrus: { coverage: number; opacity: number; color: string; scale: number; speed: number };
    stars: { density: number; intensity: number };
  };

  hemi: { sky: string; ground: string; intensity: number };
  env: { intensity: number; lightformers: LightformerDef[] };

  fog: {
    /** three.js FogExp2 color (standard materials). Usually close to `sky.haze`. */
    color: string;
    /** FogExp2 density (standard materials and the far-field shaders). */
    density: number;
    /** Extra exponential height haze for far-field shaders, density (1/m) at the cloud-sea top. */
    heightDensity: number;
    /** Height falloff of that haze (1/m). */
    heightFalloff: number;
  };

  clouds: {
    /** World Y of the cloud-sea top and its thickness (m). */
    seaTop: number;
    seaThickness: number;
    /** 0..1 fraction of the sky floor covered by clouds. */
    coverage: number;
    /** Extinction scale (higher = more opaque billows). */
    density: number;
    /** Horizontal tile size (m) of the large cloud masses (features ~1/4 of it). */
    scale: number;
    /** Tile size (m) of the billowy heads carved into the masses. */
    billowScale: number;
    lit: string;
    /** HDR multiplier on `lit` (sunlit cloud tops are brighter than sunlit concrete). */
    brightness: number;
    shade: string;
    /** Sky fill on cloud tops. */
    ambient: string;
    /** Drift (m/s) in x / z. */
    wind: [number, number];
    /** Scattered cumulus clusters around the structures. */
    cumulus: { amount: number; lit: string; shade: string; opacity: number };
  };

  landscape: {
    kind: 'mountains' | 'mesas';
    /** Sunlit rock color. */
    color: string;
    /** Shadowed rock color. */
    shade: string;
    /** Snow on high, gentle slopes (mountains). */
    snow: string | null;
    /** Vertical scale multiplier. */
    height: number;
    /** Multiplier on the aerial perspective (lower = crisper silhouettes). */
    haze: number;
    seed: number;
  } | null;

  /** Scene exposure applied before tone mapping. */
  exposure: number;
  bloom: { intensity: number; threshold: number; smoothing: number; radius: number };
  /** N8AO intensity / world radius (m). */
  ao: { intensity: number; radius: number };
  vignette: { offset: number; darkness: number };
  grade: {
    toneMapping: 'agx' | 'aces';
    /** AgX "look" (ASC-CDL in AgX log space, Filament style). Ignored by ACES. */
    look: { slope: RGB; power: number; saturation: number };
    /** Display-space finishing. */
    contrast: number;
    saturation: number;
    /** Split toning: tints mixed into shadows / highlights. */
    shadows: string;
    highlights: string;
    split: number;
    /** Lifts pure black slightly (display space, 0..0.05). */
    lift: number;
  };
}

/* ------------------------------------------------------------------ */
/* Themes                                                              */
/* ------------------------------------------------------------------ */

const MORNING: ThemeDef = {
  id: 'morning',
  name: 'Crisp Morning',
  sun: {
    elevationDeg: 25,
    azimuthDeg: -128,
    color: '#fff1de',
    intensity: 8.5,
    disk: { size: 0.6, intensity: 90 },
  },
  shadow: { intensity: 0.92, radius: 3 },
  sky: {
    zenith: '#558cd2',
    horizon: '#a6c4e6',
    haze: '#e3e0d9',
    hazeSun: '#fbecd6',
    below: '#6f7f98',
    intensity: 1.0,
    curve: 0.5,
    hazeHeight: 0.06,
    sunFocus: 2.2,
    glow: { color: '#fff0da', tight: 1.4, tightPower: 900, wide: 0.32, widePower: 7 },
    cirrus: { coverage: 0.45, opacity: 0.5, color: '#ffffff', scale: 1, speed: 1 },
    stars: { density: 0, intensity: 0 },
  },
  hemi: { sky: '#cfe0f5', ground: '#e8e2d8', intensity: 0.12 },
  env: {
    intensity: 0.62,
    lightformers: [
      { elevationDeg: 62, azimuthDeg: 160, distance: 40, size: [60, 9], color: '#ffffff', intensity: 1.4 },
      { elevationDeg: 12, azimuthDeg: 95, distance: 40, size: [50, 4], color: '#fff6ea', intensity: 1.1 },
      { elevationDeg: 10, azimuthDeg: -110, distance: 40, size: [40, 3], color: '#e8f2ff', intensity: 0.8 },
    ],
  },
  fog: { color: '#dfdfdd', density: 0.00013, heightDensity: 0.0003, heightFalloff: 0.0042 },
  clouds: {
    seaTop: -165,
    seaThickness: 95,
    coverage: 0.74,
    density: 0.06,
    scale: 5200,
    billowScale: 1500,
    lit: '#ffffff',
    brightness: 1.35,
    shade: '#8394b0',
    ambient: '#c4d6ee',
    wind: [2.2, 0.8],
    cumulus: { amount: 1, lit: '#ffffff', shade: '#a2aec2', opacity: 0.95 },
  },
  landscape: { kind: 'mountains', color: '#9aa3b2', shade: '#5c6a82', snow: '#f5f7fb', height: 1, haze: 0.48, seed: 7 },
  exposure: 0.82,
  bloom: { intensity: 0.55, threshold: 1.3, smoothing: 0.25, radius: 0.72 },
  ao: { intensity: 2.2, radius: 2.4 },
  vignette: { offset: 0.34, darkness: 0.4 },
  grade: {
    toneMapping: 'agx',
    look: { slope: [1, 1, 1], power: 1.12, saturation: 1.2 },
    contrast: 1.03,
    saturation: 1.02,
    shadows: '#29466a',
    highlights: '#fff2de',
    split: 0.07,
    lift: 0.004,
  },
};

const CANYON: ThemeDef = {
  id: 'canyon',
  name: 'Golden Canyon',
  sun: {
    elevationDeg: 10,
    azimuthDeg: 72,
    color: '#ffbd74',
    intensity: 7.2,
    disk: { size: 0.75, intensity: 38 },
  },
  shadow: { intensity: 0.96, radius: 2.6 },
  sky: {
    zenith: '#22529e',
    horizon: '#9fb5d0',
    haze: '#c0bcc2',
    hazeSun: '#ffc27a',
    below: '#5a4a50',
    intensity: 1.0,
    curve: 0.55,
    hazeHeight: 0.085,
    sunFocus: 1.5,
    glow: { color: '#ffdca6', tight: 2.2, tightPower: 420, wide: 0.75, widePower: 9 },
    cirrus: { coverage: 0.36, opacity: 0.4, color: '#ffe0bc', scale: 1.15, speed: 0.8 },
    stars: { density: 0, intensity: 0 },
  },
  hemi: { sky: '#86a2cc', ground: '#8f6048', intensity: 0.16 },
  env: {
    intensity: 0.72,
    lightformers: [
      { elevationDeg: 58, azimuthDeg: -150, distance: 40, size: [55, 7], color: '#dfe8ff', intensity: 0.9 },
      { elevationDeg: 8, azimuthDeg: -100, distance: 40, size: [50, 3], color: '#ffcf9a', intensity: 0.8 },
    ],
  },
  fog: { color: '#bfbac0', density: 0.00015, heightDensity: 0.00032, heightFalloff: 0.0036 },
  clouds: {
    seaTop: -195,
    seaThickness: 55,
    coverage: 0.36,
    density: 0.05,
    scale: 3600,
    billowScale: 800,
    lit: '#ffd49e',
    brightness: 1.3,
    shade: '#6c6a86',
    ambient: '#a4b3cb',
    wind: [1.6, -1.2],
    cumulus: { amount: 0.7, lit: '#ffdcb0', shade: '#72728e', opacity: 0.92 },
  },
  landscape: { kind: 'mesas', color: '#d4804c', shade: '#443c57', snow: null, height: 1, haze: 0.72, seed: 21 },
  exposure: 1.02,
  bloom: { intensity: 0.6, threshold: 1.1, smoothing: 0.25, radius: 0.75 },
  ao: { intensity: 2.4, radius: 2.4 },
  vignette: { offset: 0.3, darkness: 0.48 },
  grade: {
    toneMapping: 'agx',
    look: { slope: [1.03, 1.0, 0.96], power: 1.18, saturation: 1.25 },
    contrast: 1.05,
    saturation: 1.0,
    shadows: '#2c3c72',
    highlights: '#ffd8a8',
    split: 0.1,
    lift: 0.004,
  },
};

const NIGHT: ThemeDef = {
  id: 'night',
  name: 'Blue Hour Arena',
  sun: {
    elevationDeg: -8,
    azimuthDeg: -62,
    color: '#ff9a5a',
    intensity: 0,
    disk: null,
  },
  keyLight: { elevationDeg: 40, azimuthDeg: 145, color: '#9fb8ff', intensity: 0.3 },
  shadow: { intensity: 0.7, radius: 3.5 },
  sky: {
    zenith: '#030814',
    horizon: '#0f1b36',
    haze: '#141f38',
    hazeSun: '#4d3a45',
    below: '#04070d',
    intensity: 1.0,
    curve: 0.45,
    hazeHeight: 0.05,
    sunFocus: 3.2,
    glow: { color: '#ff9558', tight: 0, tightPower: 1, wide: 0.05, widePower: 14 },
    cirrus: { coverage: 0.25, opacity: 0.45, color: '#2b3652', scale: 1.1, speed: 0.6 },
    stars: { density: 0.8, intensity: 1 },
  },
  hemi: { sky: '#1a2b52', ground: '#07090f', intensity: 0.12 },
  env: {
    intensity: 0.28,
    lightformers: [
      // arena floodlight banks (white) + a faint cool wash: crisp reflections on the paint only
      { elevationDeg: 22, azimuthDeg: -35, distance: 40, size: [3.2, 1.2], color: '#f4f7ff', intensity: 7 },
      { elevationDeg: 24, azimuthDeg: 40, distance: 40, size: [3.2, 1.2], color: '#f4f7ff', intensity: 6 },
      { elevationDeg: 18, azimuthDeg: 150, distance: 40, size: [3.6, 1.2], color: '#f4f7ff', intensity: 5 },
      { elevationDeg: 70, azimuthDeg: 0, distance: 40, size: [36, 5], color: '#24365e', intensity: 0.8 },
    ],
  },
  fog: { color: '#0c1322', density: 0.00016, heightDensity: 0.00028, heightFalloff: 0.004 },
  clouds: {
    seaTop: -170,
    seaThickness: 60,
    coverage: 0.7,
    density: 0.06,
    scale: 4000,
    billowScale: 900,
    lit: '#263249',
    brightness: 0.9,
    shade: '#0c111d',
    ambient: '#121a2d',
    wind: [1.2, 0.5],
    cumulus: { amount: 0.55, lit: '#2c374f', shade: '#0f1524', opacity: 0.9 },
  },
  landscape: { kind: 'mountains', color: '#151c2b', shade: '#0b1019', snow: '#2c3650', height: 0.9, haze: 0.55, seed: 7 },
  exposure: 1.2,
  bloom: { intensity: 0.9, threshold: 0.85, smoothing: 0.3, radius: 0.8 },
  ao: { intensity: 1.8, radius: 2.2 },
  vignette: { offset: 0.28, darkness: 0.55 },
  grade: {
    toneMapping: 'agx',
    look: { slope: [0.98, 1.0, 1.04], power: 1.08, saturation: 1.08 },
    contrast: 1.04,
    saturation: 1.0,
    shadows: '#18284c',
    highlights: '#ffe4c8',
    split: 0.08,
    lift: 0.006,
  },
};

const TITLE: ThemeDef = {
  id: 'title',
  name: 'Golden Showroom',
  sun: {
    elevationDeg: 13,
    azimuthDeg: 128,
    color: '#ffcf9c',
    intensity: 6.6,
    disk: { size: 0.7, intensity: 50 },
  },
  shadow: { intensity: 0.9, radius: 3.2 },
  sky: {
    zenith: '#2a5ead',
    horizon: '#a0bad9',
    haze: '#cdd2dc',
    hazeSun: '#ffcb8c',
    below: '#454a60',
    intensity: 1.0,
    curve: 0.55,
    hazeHeight: 0.085,
    sunFocus: 1.4,
    glow: { color: '#ffdfab', tight: 1.8, tightPower: 420, wide: 0.7, widePower: 8 },
    cirrus: { coverage: 0.4, opacity: 0.45, color: '#ffe4c6', scale: 1, speed: 0.7 },
    stars: { density: 0, intensity: 0 },
  },
  hemi: { sky: '#9cbbe8', ground: '#b4aaa6', intensity: 0.2 },
  env: {
    intensity: 1.0,
    lightformers: [
      // showroom: broad soft key overhead, two long strips for crisp body-line highlights
      { elevationDeg: 75, azimuthDeg: 0, distance: 30, size: [30, 14], color: '#ffffff', intensity: 2.2 },
      { elevationDeg: 14, azimuthDeg: -70, distance: 30, size: [44, 2.4], color: '#fff3e6', intensity: 2.4 },
      { elevationDeg: 16, azimuthDeg: 60, distance: 30, size: [44, 2.0], color: '#e9f3ff', intensity: 1.8 },
      { elevationDeg: 30, azimuthDeg: 180, distance: 30, size: [8, 8], color: '#ffffff', intensity: 1.5, shape: 'disc' },
    ],
  },
  fog: { color: '#ccd1da', density: 0.00015, heightDensity: 0.00035, heightFalloff: 0.004 },
  clouds: {
    seaTop: -150,
    seaThickness: 70,
    coverage: 0.76,
    density: 0.06,
    scale: 4200,
    billowScale: 950,
    lit: '#ffe6c2',
    brightness: 1.3,
    shade: '#6d7899',
    ambient: '#a9bfe2',
    wind: [1.4, 0.6],
    cumulus: { amount: 0.8, lit: '#ffe9ca', shade: '#7880a0', opacity: 0.95 },
  },
  landscape: { kind: 'mountains', color: '#b89c90', shade: '#4d5775', snow: '#fff3e6', height: 0.78, haze: 0.74, seed: 11 },
  exposure: 1.02,
  bloom: { intensity: 0.65, threshold: 1.1, smoothing: 0.25, radius: 0.75 },
  ao: { intensity: 2.2, radius: 1.6 },
  vignette: { offset: 0.3, darkness: 0.5 },
  grade: {
    toneMapping: 'agx',
    look: { slope: [1.02, 1.0, 0.97], power: 1.18, saturation: 1.25 },
    contrast: 1.04,
    saturation: 1.0,
    shadows: '#2b3f75',
    highlights: '#ffe2bf',
    split: 0.1,
    lift: 0.004,
  },
};

export const THEMES: Readonly<Record<ThemeId, ThemeDef>> = {
  title: TITLE,
  morning: MORNING,
  canyon: CANYON,
  night: NIGHT,
};

export function getTheme(id: ThemeId): ThemeDef {
  return THEMES[id] ?? MORNING;
}

/** Accepts a theme id or a full definition (custom / tweaked themes). */
export function resolveTheme(theme: ThemeId | ThemeDef): ThemeDef {
  return typeof theme === 'string' ? getTheme(theme) : theme;
}

/* ------------------------------------------------------------------ */
/* Direction helpers                                                    */
/* ------------------------------------------------------------------ */

const DEG = Math.PI / 180;

/** Unit vector pointing from the scene toward (elevation, azimuth). See the convention at the top. */
export function directionFromAngles(elevationDeg: number, azimuthDeg: number, out = new Vector3()): Vector3 {
  const el = elevationDeg * DEG;
  const az = azimuthDeg * DEG;
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

/** Direction toward the sky sun (may be below the horizon for the night theme). */
export function sunDirection(theme: ThemeId | ThemeDef, out = new Vector3()): Vector3 {
  const t = resolveTheme(theme);
  return directionFromAngles(t.sun.elevationDeg, t.sun.azimuthDeg, out);
}

/** Direction toward the shadow-casting key light (sun, or the night moonlight). */
export function keyLightDirection(theme: ThemeId | ThemeDef, out = new Vector3()): Vector3 {
  const t = resolveTheme(theme);
  const k = t.keyLight;
  return k ? directionFromAngles(k.elevationDeg, k.azimuthDeg, out) : directionFromAngles(t.sun.elevationDeg, t.sun.azimuthDeg, out);
}
