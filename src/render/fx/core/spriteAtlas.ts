/**
 * Procedural sprite atlas shared by all particle pools (no image files).
 *
 * 512x512 RGBA8, 2x2 cells of 256 px. In every cell:
 *   R  = soft radial glow (identical in all cells; used by sprite 0 — embers, sparks, sparkles)
 *   G  = billowy smoke puff density (4 different variants, sprites 1..4)
 *   BA = puff normal (x, y) encoded 0..1 — lets the shader light smoke from the sun direction
 *
 * Puffs are built like cumulus billows: a smooth union of hemispherical lobes (one large core lobe
 * plus smaller lobes biased upwards), whose height field gives true per-lobe normals, so lit puffs
 * show rounded, individually shaded "cauliflower" lobes. Gentle fbm erosion keeps the silhouette
 * organic and the interior slightly uneven.
 *
 * Texture rows are bottom-up (flipY = false), so +y in the generator is "up" on the billboard.
 */
import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RGBAFormat,
  UnsignedByteType,
} from 'three';

const CELL = 256;
const SIZE = CELL * 2;

/** Deterministic 2D integer hash -> [0, 1). */
function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + i * 31);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Polynomial smooth maximum (blends overlapping lobes into one continuous surface). */
function smax(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

interface Lobe {
  x: number;
  y: number;
  r: number;
}

function makeLobes(variant: number): Lobe[] {
  const rand = rng(9173 + variant * 7919);
  const lobes: Lobe[] = [{ x: (rand() - 0.5) * 0.08, y: -0.08, r: 0.5 + rand() * 0.06 }];
  const count = 7 + (variant % 3);
  for (let i = 0; i < count; i++) {
    // spread around the core, biased upwards (billows grow up and out), kept inside the cell
    const ang = (i / count) * Math.PI * 2 + rand() * 0.9;
    const dist = 0.24 + rand() * 0.26;
    const r = 0.2 + rand() * 0.2;
    let x = Math.cos(ang) * dist;
    let y = Math.sin(ang) * dist * 0.85 + 0.06;
    const reach = Math.hypot(x, y) + r;
    if (reach > 0.9) {
      const k = (0.9 - r) / Math.max(1e-3, Math.hypot(x, y));
      x *= k;
      y *= k;
    }
    lobes.push({ x, y, r });
  }
  return lobes;
}

/** Puff height field (hemispherical lobes, smooth union) for one cell; heights in cell units. */
function puffHeight(variant: number, out: Float32Array): void {
  const lobes = makeLobes(variant);
  const seed = 101 + variant * 57;
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const px = ((x + 0.5) / CELL) * 2 - 1;
      const py = ((y + 0.5) / CELL) * 2 - 1;
      // slight domain warp: lobes are not perfect circles
      const wx = px + (fbm(px * 2.2, py * 2.2, seed, 2) - 0.5) * 0.12;
      const wy = py + (fbm(px * 2.2 + 7.1, py * 2.2 + 3.3, seed + 5, 2) - 0.5) * 0.12;
      let h = 0;
      for (let i = 0; i < lobes.length; i++) {
        const l = lobes[i];
        const dx = wx - l.x;
        const dy = wy - l.y;
        const d2 = l.r * l.r - dx * dx - dy * dy;
        if (d2 > 0) h = smax(h, Math.sqrt(d2), 0.09);
      }
      out[y * CELL + x] = h;
    }
  }
}

/** Pixel data is generated once per page and shared by every atlas texture. */
let cachedPixels: Uint8Array | null = null;

/** Creates the atlas texture. Caller owns it (dispose when done). */
export function createSpriteAtlas(): DataTexture {
  cachedPixels ??= generatePixels();
  const tex = new DataTexture(cachedPixels, SIZE, SIZE, RGBAFormat, UnsignedByteType);
  tex.name = 'fx-sprite-atlas';
  tex.colorSpace = NoColorSpace;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

function generatePixels(): Uint8Array {
  const data = new Uint8Array(SIZE * SIZE * 4);
  const height = new Float32Array(CELL * CELL);
  const texel = 2 / CELL; // cell units per pixel

  for (let cell = 0; cell < 4; cell++) {
    const ox = (cell % 2) * CELL;
    const oy = Math.floor(cell / 2) * CELL;
    const seed = 101 + cell * 57;
    puffHeight(cell, height);

    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const px = ((x + 0.5) / CELL) * 2 - 1;
        const py = ((y + 0.5) / CELL) * 2 - 1;
        const r2 = px * px + py * py;
        const r = Math.sqrt(r2);
        const h = height[y * CELL + x];

        // glow: wide gaussian + hot core, forced to zero at the cell edge
        let glow = 0.72 * Math.exp(-r2 * 5.5) + 0.28 * Math.exp(-r2 * 32);
        glow *= 1 - smooth(0.72, 1.0, r);

        // density: soft rim eroded by noise (subtractive only: nothing leaks outside the lobes),
        // slightly uneven interior
        const detail = fbm(px * 4.1 + cell * 3.7, py * 4.1 - cell * 1.9, seed + 31, 4);
        const erosion = fbm(px * 7.3 - cell * 2.1, py * 7.3 + cell * 5.3, seed + 63, 3);
        let density = smooth(0.0, 0.42, h - erosion * 0.11) * (0.82 + 0.24 * detail);
        density *= 1 - smooth(0.9, 0.99, r);

        // normal from the lobe height field (central differences), + fine detail bumps
        const xm = Math.max(0, x - 1);
        const xp = Math.min(CELL - 1, x + 1);
        const ym = Math.max(0, y - 1);
        const yp = Math.min(CELL - 1, y + 1);
        const hx = (height[y * CELL + xp] - height[y * CELL + xm]) / ((xp - xm) * texel);
        const hy = (height[yp * CELL + x] - height[ym * CELL + x]) / ((yp - ym) * texel);
        let nx = -Math.max(-4, Math.min(4, hx));
        let ny = -Math.max(-4, Math.min(4, hy));
        let nz = 1;
        // outside / at the rim the height is flat: fall back to a sphere-ish normal
        const rim = 1 - smooth(0.0, 0.08, h);
        nx = nx * (1 - rim) + px * 1.4 * rim;
        ny = ny * (1 - rim) + py * 1.4 * rim;
        nx += (detail - 0.5) * 0.25;
        ny += (fbm(px * 4.1 + 9.2, py * 4.1 + 4.4, seed + 47, 3) - 0.5) * 0.25;
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx *= inv;
        ny *= inv;
        nz *= inv;

        const o = ((oy + y) * SIZE + (ox + x)) * 4;
        data[o] = Math.round(Math.min(1, glow) * 255);
        data[o + 1] = Math.round(Math.min(1, Math.max(0, density)) * 255);
        data[o + 2] = Math.round((nx * 0.5 + 0.5) * 255);
        data[o + 3] = Math.round((ny * 0.5 + 0.5) * 255);
      }
    }
  }

  return data;
}
