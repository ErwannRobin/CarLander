/**
 * Low-level helpers for procedural canvas textures: seeded RNG, tileable fractal noise,
 * height -> normal conversion and CanvasTexture factories with consistent sampler settings.
 *
 * Conventions used by every generator in this folder:
 *  - Textures are created with `flipY = false`, so canvas pixel row 0 maps to v = 0 and canvas
 *    y grows with v. For track tops (v = arc length) "canvas down" therefore means "forward".
 *  - Data maps (roughness / normal / masks) use NoColorSpace; color maps use SRGBColorSpace.
 *  - Noise fields are periodic so every texture tiles seamlessly with RepeatWrapping.
 */
import {
  CanvasTexture,
  ClampToEdgeWrapping,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three';

/** three.js clamps this to the GPU maximum (WebGLTextures uses min(texture.anisotropy, max)). */
export const MAX_ANISOTROPY = 16;

export interface Canvas2D {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
}

export function createCanvas(width: number, height: number): Canvas2D {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  return { canvas, ctx, width, height };
}

/** Small, fast, deterministic PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FbmOptions {
  /** Lattice cells across the texture width for the first octave (integer => tileable). */
  cellsX: number;
  /** Lattice cells across the height for the first octave. Default: cellsX scaled by aspect. */
  cellsY?: number;
  octaves?: number;
  /** Amplitude multiplier per octave. */
  gain?: number;
  seed?: number;
}

/**
 * Tileable fractal value noise, normalized to [0, 1]. Each octave doubles the lattice resolution
 * (integer cell counts keep the field periodic). Column/row interpolation terms are precomputed
 * per octave so the inner loop is a handful of multiply-adds.
 */
export function fbmField(w: number, h: number, opts: FbmOptions): Float32Array {
  const octaves = opts.octaves ?? 5;
  const gain = opts.gain ?? 0.5;
  const rng = mulberry32(opts.seed ?? 1);
  const out = new Float32Array(w * h);
  let amp = 1;
  let total = 0;
  const baseX = Math.max(1, Math.round(opts.cellsX));
  const baseY = Math.max(1, Math.round(opts.cellsY ?? (opts.cellsX * h) / w));
  const ix0 = new Int32Array(w);
  const ix1 = new Int32Array(w);
  const tx = new Float32Array(w);
  for (let o = 0; o < octaves; o++) {
    const cx = baseX << o;
    const cy = baseY << o;
    const lattice = new Float32Array(cx * cy);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rng();
    for (let x = 0; x < w; x++) {
      const fx = (x / w) * cx;
      const i0 = Math.floor(fx);
      const t = fx - i0;
      ix0[x] = i0 % cx;
      ix1[x] = (i0 + 1) % cx;
      tx[x] = t * t * (3 - 2 * t);
    }
    for (let y = 0; y < h; y++) {
      const fy = (y / h) * cy;
      const j0 = Math.floor(fy);
      let ty = fy - j0;
      ty = ty * ty * (3 - 2 * ty);
      const r0 = (j0 % cy) * cx;
      const r1 = ((j0 + 1) % cy) * cx;
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const a = lattice[r0 + ix0[x]];
        const b = lattice[r0 + ix1[x]];
        const c = lattice[r1 + ix0[x]];
        const d = lattice[r1 + ix1[x]];
        const top = a + (b - a) * tx[x];
        const bot = c + (d - c) * tx[x];
        out[row + x] += (top + (bot - top) * ty) * amp;
      }
    }
    total += amp;
    amp *= gain;
  }
  const inv = 1 / total;
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  return out;
}

/** Stretches a [0,1] field's contrast around its mean (in place). */
export function contrast(field: Float32Array, k: number): Float32Array {
  let mean = 0;
  for (let i = 0; i < field.length; i++) mean += field[i];
  mean /= field.length;
  for (let i = 0; i < field.length; i++) field[i] = clamp01(0.5 + (field[i] - mean) * k);
  return field;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/**
 * Splats a soft round "stone" into float buffers with wrap-around (tileable).
 * `apply(index, coverage)` is called for each covered pixel with coverage in (0, 1].
 */
export function splatDisc(
  w: number,
  h: number,
  cx: number,
  cy: number,
  radius: number,
  apply: (index: number, coverage: number) => void,
): void {
  const r = Math.max(0.5, radius);
  const x0 = Math.floor(cx - r - 1);
  const x1 = Math.ceil(cx + r + 1);
  const y0 = Math.floor(cy - r - 1);
  const y1 = Math.ceil(cy + r + 1);
  for (let y = y0; y <= y1; y++) {
    const wy = ((y % h) + h) % h;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= r + 0.5) continue;
      const cov = d <= r - 0.5 ? 1 : r + 0.5 - d;
      const wx = ((x % w) + w) % w;
      apply(wy * w + wx, cov);
    }
  }
}

/**
 * Converts a periodic height field into a tangent-space normal map (OpenGL convention,
 * +X = +u, +Y = +v with flipY = false). `strength` scales slopes (height units per pixel).
 */
export function heightToNormal(height: Float32Array, w: number, h: number, strength: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const ym = ((y - 1 + h) % h) * w;
    const yp = ((y + 1) % h) * w;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const xm = (x - 1 + w) % w;
      const xp = (x + 1) % w;
      const dx = (height[row + xp] - height[row + xm]) * strength;
      const dy = (height[yp + x] - height[ym + x]) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const o = (row + x) * 4;
      out[o] = (-dx * inv * 0.5 + 0.5) * 255;
      out[o + 1] = (-dy * inv * 0.5 + 0.5) * 255;
      out[o + 2] = (inv * 0.5 + 0.5) * 255;
      out[o + 3] = 255;
    }
  }
  return out;
}

/** Writes RGBA bytes to a fresh canvas. */
export function canvasFromRGBA(data: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const { canvas, ctx } = createCanvas(w, h);
  const img = ctx.createImageData(w, h);
  img.data.set(data);
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Packs up to four [0,1] float channels into RGBA bytes (missing channels: 0, alpha 1). */
export function packChannels(
  w: number,
  h: number,
  r: Float32Array,
  g?: Float32Array,
  b?: Float32Array,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    out[o] = r[i] * 255;
    out[o + 1] = g ? g[i] * 255 : 0;
    out[o + 2] = b ? b[i] * 255 : 0;
    out[o + 3] = 255;
  }
  return out;
}

export interface TextureOptions {
  /** Color data (sRGB) vs. non-color data. */
  color: boolean;
  /** Repeat wrapping on both axes (default true). */
  repeat?: boolean;
  /** Default false (see header). */
  flipY?: boolean;
  /** UV channel used by materials (0 = layout `uv`, 1 = metric `uv1`). */
  channel?: number;
  mipmaps?: boolean;
}

/** Creates a CanvasTexture with the project's sampler conventions (max anisotropy, trilinear). */
export function makeTexture(canvas: HTMLCanvasElement, opts: TextureOptions): CanvasTexture {
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = opts.color ? SRGBColorSpace : NoColorSpace;
  const wrap = opts.repeat === false ? ClampToEdgeWrapping : RepeatWrapping;
  tex.wrapS = wrap;
  tex.wrapT = wrap;
  tex.flipY = opts.flipY ?? false;
  tex.anisotropy = MAX_ANISOTROPY;
  tex.channel = opts.channel ?? 0;
  const mip = opts.mipmaps ?? true;
  tex.generateMipmaps = mip;
  tex.minFilter = mip ? LinearMipmapLinearFilter : LinearFilter;
  tex.magFilter = LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Hex '#rrggbb' -> [r, g, b] 0..255. */
export function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** CSS rgba() string from a palette hex and an alpha. */
export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** Shades a hex color by a multiplier (in sRGB byte space) and returns a CSS rgb() string. */
export function shade(hex: string, k: number): string {
  const [r, g, b] = hexRgb(hex);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c * k)));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}
