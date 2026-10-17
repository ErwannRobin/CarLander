/**
 * Procedural track & architecture textures, generated once on first use and cached.
 *
 * Two families, mapped to two UV channels on every level mesh:
 *
 *  - DETAIL maps (channel 1 = `uv1`, metric meters, small tiles): micro surface detail that must
 *    stay the same physical size on every piece. Packed as R = albedo multiplier (0.5 = neutral,
 *    injected by materials.ts), G = roughness, B = height. Each comes with a normal map.
 *       asphalt  — graphite micro-aggregate (stones, binder, pores)
 *       concrete — mottled cement with sand grain and air pores (also used polished)
 *       brushed  — brushed titanium streaks
 *
 *  - LAYOUT maps (channel 0 = `uv`): ribbon tops use u = 0..1 across the width and v = meters
 *    along the path (see Ribbon.ts). Each layout is authored for a nominal width and a repeat
 *    period along v; markings scale with the actual piece width.
 *       runway   — solid white edges, cyan dashed center (emissive), lane dashes, distance ticks
 *       ramp     — bold orange/white chevrons pointing up-ramp (towards +v)
 *       landing  — cast concrete panels, touchdown bars, rubber marks
 *       adhesive — polished light-grey concrete, white center line, faint cyan micro-grid (emissive)
 *       platform — large concrete panels with titanium expansion joints
 *       metal    — brushed titanium plates with fastener rows
 *       glass    — dark glass with titanium mullions
 *    plus `fascia` (metric, slab sides) and `ledDots` (LED strip diffuser pattern).
 */
import type { CanvasTexture } from 'three';
import { PALETTE } from '@/render/palette';
import type { TrackStyle } from '@/game/types';
import {
  canvasFromRGBA,
  clamp01,
  contrast,
  createCanvas,
  fbmField,
  heightToNormal,
  makeTexture,
  mulberry32,
  packChannels,
  rgba,
  splatDisc,
  type Canvas2D,
} from './canvasUtils';

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

const cache = new Map<string, unknown>();

function cached<T>(key: string, make: () => T): T {
  let v = cache.get(key) as T | undefined;
  if (v === undefined) {
    v = make();
    cache.set(key, v);
  }
  return v;
}

/** Disposes every cached level texture (call only on full renderer teardown). */
export function disposeTrackTextures(): void {
  const isTexture = (t: unknown): t is CanvasTexture => !!t && (t as CanvasTexture).isTexture === true;
  for (const v of cache.values()) {
    if (isTexture(v)) v.dispose();
    else for (const t of Object.values(v as Record<string, unknown>)) if (isTexture(t)) t.dispose();
  }
  cache.clear();
}

/* ------------------------------------------------------------------ */
/* Detail maps (metric, channel 1)                                     */
/* ------------------------------------------------------------------ */

export interface DetailTextures {
  /** R = albedo multiplier (0.5 neutral), G = roughness, B = height. Non-color. */
  detail: CanvasTexture;
  normal: CanvasTexture;
  /** Physical size of one tile (m). Apply as texture.repeat = 1 / tile on metric UVs. */
  tile: number;
}

function detailSet(albedo: Float32Array, rough: Float32Array, height: Float32Array, size: number, normalStrength: number, tile: number): DetailTextures {
  const detail = makeTexture(canvasFromRGBA(packChannels(size, size, albedo, rough, height), size, size), {
    color: false,
    channel: 1,
  });
  const normal = makeTexture(canvasFromRGBA(heightToNormal(height, size, size, normalStrength), size, size), {
    color: false,
    channel: 1,
  });
  detail.repeat.set(1 / tile, 1 / tile);
  normal.repeat.set(1 / tile, 1 / tile);
  return { detail, normal, tile };
}

/** Graphite asphalt micro-aggregate, 2.4 m tile. */
export function getAsphaltDetail(): DetailTextures {
  return cached('asphaltDetail', () => {
    const S = 512;
    const N = S * S;
    const rng = mulberry32(7);
    const mott = contrast(fbmField(S, S, { cellsX: 5, octaves: 5, gain: 0.55, seed: 11 }), 1.6);
    const grain = fbmField(S, S, { cellsX: 96, octaves: 2, gain: 0.5, seed: 12 });
    const albedo = new Float32Array(N);
    const rough = new Float32Array(N);
    const height = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      // bitumen binder: dark, slightly varied
      albedo[i] = 0.4 + (mott[i] - 0.5) * 0.16 + (grain[i] - 0.5) * 0.1;
      rough[i] = 0.9 + (grain[i] - 0.5) * 0.06;
      height[i] = mott[i] * 0.2 + grain[i] * 0.25;
    }
    // aggregate stones: many small, few larger; mostly mid-grey, some bright quartz
    const stones = Math.round(N / 7);
    for (let s = 0; s < stones; s++) {
      const r = 0.6 + Math.pow(rng(), 2.2) * 2.6;
      const bright = rng();
      const tone = bright > 0.93 ? 0.85 + rng() * 0.15 : 0.42 + rng() * 0.28;
      const h = 0.45 + rng() * 0.45;
      const ro = 0.62 + rng() * 0.18; // tire-polished stone tops
      splatDisc(S, S, rng() * S, rng() * S, r, (i, c) => {
        albedo[i] += (tone - albedo[i]) * c;
        rough[i] += (ro - rough[i]) * c;
        height[i] = Math.max(height[i], 0.35 + h * c);
      });
    }
    // pores
    for (let s = 0; s < N / 90; s++) {
      splatDisc(S, S, rng() * S, rng() * S, 0.5 + rng() * 0.9, (i, c) => {
        albedo[i] *= 1 - 0.5 * c;
        rough[i] = Math.min(1, rough[i] + 0.08 * c);
        height[i] -= 0.35 * c;
      });
    }
    for (let i = 0; i < N; i++) {
      albedo[i] = clamp01(albedo[i]);
      rough[i] = clamp01(rough[i]);
      height[i] = clamp01(height[i]);
    }
    return detailSet(albedo, rough, height, S, 2.2, 2.4);
  });
}

/** Mottled cement with sand grain and air pores, 3.2 m tile. Use material.roughness to polish. */
export function getConcreteDetail(): DetailTextures {
  return cached('concreteDetail', () => {
    const S = 512;
    const N = S * S;
    const rng = mulberry32(21);
    const mott = contrast(fbmField(S, S, { cellsX: 3, octaves: 6, gain: 0.58, seed: 31 }), 1.5);
    const cloud = contrast(fbmField(S, S, { cellsX: 2, octaves: 4, gain: 0.5, seed: 32 }), 1.3);
    const sand = fbmField(S, S, { cellsX: 128, octaves: 2, gain: 0.6, seed: 33 });
    const albedo = new Float32Array(N);
    const rough = new Float32Array(N);
    const height = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const fine = (rng() - 0.5) * 0.035;
      albedo[i] = 0.5 + (mott[i] - 0.5) * 0.12 + (cloud[i] - 0.5) * 0.08 + (sand[i] - 0.5) * 0.08 + fine;
      rough[i] = 0.78 + (cloud[i] - 0.5) * 0.18 + (sand[i] - 0.5) * 0.08;
      height[i] = mott[i] * 0.25 + sand[i] * 0.35 + fine;
    }
    // air pores ("bug holes")
    for (let s = 0; s < N / 260; s++) {
      const r = 0.5 + Math.pow(rng(), 2) * 1.6;
      splatDisc(S, S, rng() * S, rng() * S, r, (i, c) => {
        albedo[i] *= 1 - 0.32 * c;
        rough[i] = Math.min(1, rough[i] + 0.12 * c);
        height[i] -= 0.5 * c;
      });
    }
    for (let i = 0; i < N; i++) {
      albedo[i] = clamp01(albedo[i]);
      rough[i] = clamp01(rough[i]);
      height[i] = clamp01(height[i]);
    }
    return detailSet(albedo, rough, height, S, 1.1, 3.2);
  });
}

/** Brushed titanium: fine streaks along v (canvas y), 1.6 m tile. */
export function getBrushedDetail(): DetailTextures {
  return cached('brushedDetail', () => {
    const S = 512;
    const N = S * S;
    const rng = mulberry32(41);
    // 1D streak profile across u, slowly modulated along v
    const streak = new Float32Array(S);
    for (let x = 0; x < S; x++) streak[x] = rng();
    // blur slightly so streaks are 1-3 px wide
    const blurred = new Float32Array(S);
    for (let x = 0; x < S; x++) {
      blurred[x] = (streak[(x - 1 + S) % S] + 2 * streak[x] + streak[(x + 1) % S]) / 4;
    }
    const slow = fbmField(S, S, { cellsX: 64, cellsY: 2, octaves: 3, gain: 0.5, seed: 43 });
    const patch = contrast(fbmField(S, S, { cellsX: 3, octaves: 4, gain: 0.5, seed: 44 }), 1.4);
    const albedo = new Float32Array(N);
    const rough = new Float32Array(N);
    const height = new Float32Array(N);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const s = blurred[x] * 0.65 + slow[i] * 0.35;
        albedo[i] = clamp01(0.5 + (s - 0.5) * 0.12 + (patch[i] - 0.5) * 0.06);
        rough[i] = clamp01(0.55 + (s - 0.5) * 0.3 + (patch[i] - 0.5) * 0.15);
        height[i] = s;
      }
    }
    return detailSet(albedo, rough, height, S, 0.6, 1.6);
  });
}

/* ------------------------------------------------------------------ */
/* Layout maps (channel 0)                                             */
/* ------------------------------------------------------------------ */

export interface LayoutTextures {
  map: CanvasTexture;
  /** Grayscale emissive mask (material.emissive provides the tint), if the style glows. */
  emissive: CanvasTexture | null;
  /** Repeat period along v (m). Applied as texture.repeat.y = 1 / period. */
  period: number;
  /** Width (m) the layout was authored for (markings scale with the real width). */
  nominalWidth: number;
}

/** A canvas whose drawing space is meters (x across, y along +v), with tiling helpers. */
class MeterCanvas {
  readonly c: Canvas2D;
  readonly ppmX: number;
  readonly ppmY: number;
  constructor(
    readonly widthM: number,
    readonly periodM: number,
    pxW: number,
    pxH: number,
  ) {
    this.c = createCanvas(pxW, pxH);
    this.ppmX = pxW / widthM;
    this.ppmY = pxH / periodM;
    this.reset();
  }
  get ctx(): CanvasRenderingContext2D {
    return this.c.ctx;
  }
  /** Restore the meter transform. */
  reset(): void {
    this.c.ctx.setTransform(this.ppmX, 0, 0, this.ppmY, 0, 0);
    this.c.ctx.globalAlpha = 1;
    this.c.ctx.globalCompositeOperation = 'source-over';
  }
  /** Draw `fn` at y, y - period and y + period so shapes crossing the seam tile correctly. */
  wrapY(fn: (dy: number) => void): void {
    fn(0);
    fn(-this.periodM);
    fn(this.periodM);
  }
  rect(x: number, y: number, w: number, h: number, style: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = style;
    this.wrapY((dy) => ctx.fillRect(x, y + dy, w, h));
  }
}

/**
 * Fills the canvas with a base color modulated by tileable low-frequency noise
 * (macro patches), computed at low resolution and upscaled seamlessly.
 */
function fillMacro(mc: MeterCanvas, baseHex: string, amount: number, seed: number, cells = 6): void {
  const lw = Math.max(16, Math.round(mc.c.width / 4));
  const lh = Math.max(16, Math.round(mc.c.height / 4));
  const n = contrast(fbmField(lw, lh, { cellsX: cells, octaves: 5, gain: 0.55, seed }), 1.5);
  const [r, g, b] = [parseInt(baseHex.slice(1, 3), 16), parseInt(baseHex.slice(3, 5), 16), parseInt(baseHex.slice(5, 7), 16)];
  const data = new Uint8ClampedArray(lw * lh * 4);
  for (let i = 0; i < lw * lh; i++) {
    const k = 1 + (n[i] - 0.5) * 2 * amount;
    data[i * 4] = r * k;
    data[i * 4 + 1] = g * k;
    data[i * 4 + 2] = b * k;
    data[i * 4 + 3] = 255;
  }
  const small = canvasFromRGBA(data, lw, lh);
  // 3x3 tiling so bilinear upscaling wraps seamlessly at the borders
  const tiled = createCanvas(lw * 3, lh * 3);
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) tiled.ctx.drawImage(small, i * lw, j * lh);
  const ctx = mc.ctx;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tiled.canvas, lw, lh, lw, lh, 0, 0, mc.c.width, mc.c.height);
  ctx.restore();
}

/** Removes small flecks of paint (wear) from a paint layer canvas. */
function wearPaint(layer: Canvas2D, amount: number, seed: number): void {
  const rng = mulberry32(seed);
  const ctx = layer.ctx;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'destination-out';
  const count = Math.round(layer.width * layer.height * amount * 0.002);
  for (let i = 0; i < count; i++) {
    ctx.globalAlpha = 0.25 + rng() * 0.6;
    const s = 1 + rng() * 2.2;
    ctx.fillRect(rng() * layer.width, rng() * layer.height, s, s);
  }
  ctx.restore();
}

/** Soft longitudinal band (wheel path, rubber mark) wrapping along v. */
function band(mc: MeterCanvas, xCenter: number, width: number, color: string, alpha: number): void {
  const ctx = mc.ctx;
  const g = ctx.createLinearGradient(xCenter - width / 2, 0, xCenter + width / 2, 0);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.5, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = alpha;
  ctx.fillStyle = g;
  ctx.fillRect(xCenter - width / 2, 0, width, mc.periodM);
  ctx.globalAlpha = 1;
}

function layoutSet(mc: MeterCanvas, emissive: MeterCanvas | null): LayoutTextures {
  const map = makeTexture(mc.c.canvas, { color: true, channel: 0 });
  map.repeat.set(1, 1 / mc.periodM);
  let em: CanvasTexture | null = null;
  if (emissive) {
    em = makeTexture(emissive.c.canvas, { color: true, channel: 0 });
    em.repeat.set(1, 1 / mc.periodM);
  }
  return { map, emissive: em, period: mc.periodM, nominalWidth: mc.widthM };
}

const PAINT = PALETTE.warmWhite;
/** Edge line inset/width (m) shared by all asphalt/concrete layouts. */
const EDGE_IN = 0.45;
const EDGE_W = 0.38;

function edgeLines(mc: MeterCanvas, style: string): void {
  mc.rect(EDGE_IN, 0, EDGE_W, mc.periodM, style);
  mc.rect(mc.widthM - EDGE_IN - EDGE_W, 0, EDGE_W, mc.periodM, style);
}

function runwayLayout(): LayoutTextures {
  const W = 26;
  const P = 40;
  const mc = new MeterCanvas(W, P, 1024, 1600);
  fillMacro(mc, '#2e3136', 0.07, 101, 5);
  mc.reset();
  // tire-polished wheel paths (4 lanes, 2 paths each)
  for (let lane = 0; lane < 4; lane++) {
    const c = (lane + 0.5) * (W / 4);
    band(mc, c - 0.9, 0.9, 'rgba(10,11,13,1)', 0.16);
    band(mc, c + 0.9, 0.9, 'rgba(10,11,13,1)', 0.16);
  }
  // paint layer
  const paint = new MeterCanvas(W, P, 1024, 1600);
  edgeLines(paint, PAINT);
  for (const x of [W / 4, (3 * W) / 4]) {
    for (let y = 0; y < P; y += 10) paint.rect(x - 0.08, y + 3.5, 0.16, 3, rgba(PAINT, 0.7));
  }
  // distance ticks every 10 m, long tick once per period
  for (let y = 0; y < P; y += 10) {
    const len = y === 0 ? 2.6 : 1.2;
    paint.rect(EDGE_IN + EDGE_W + 0.5, y + 8.2, len, 0.32, PAINT);
    paint.rect(W - EDGE_IN - EDGE_W - 0.5 - len, y + 8.2, len, 0.32, PAINT);
  }
  // cyan dashed center line (paint body, emissive core below)
  for (let y = 0; y < P; y += 10) paint.rect(W / 2 - 0.2, y, 0.4, 6, PALETTE.cyan);
  wearPaint(paint.c, 1, 102);
  mc.ctx.setTransform(1, 0, 0, 1, 0, 0);
  mc.ctx.drawImage(paint.c.canvas, 0, 0);

  const em = new MeterCanvas(W, P, 512, 800);
  em.ctx.fillStyle = '#000';
  em.ctx.fillRect(0, 0, W, P);
  for (let y = 0; y < P; y += 10) em.rect(W / 2 - 0.14, y + 0.05, 0.28, 5.9, '#ffffff');
  return layoutSet(mc, em);
}

function rampLayout(): LayoutTextures {
  const W = 16;
  const P = 12;
  const mc = new MeterCanvas(W, P, 1024, 512);
  fillMacro(mc, '#2b2e32', 0.06, 201, 4);
  mc.reset();
  const paint = new MeterCanvas(W, P, 1024, 512);
  edgeLines(paint, PAINT);
  const ctx = paint.ctx;
  ctx.lineJoin = 'miter';
  ctx.miterLimit = 10;
  ctx.lineCap = 'butt';
  ctx.lineWidth = 1.15;
  const chevron = (y0: number, color: string) => {
    ctx.strokeStyle = color;
    paint.wrapY((dy) => {
      ctx.beginPath();
      ctx.moveTo(1.7, y0 + dy);
      ctx.lineTo(W / 2, y0 + 2.9 + dy);
      ctx.lineTo(W - 1.7, y0 + dy);
      ctx.stroke();
    });
  };
  chevron(1.2, PALETTE.orange);
  chevron(7.2, PAINT);
  wearPaint(paint.c, 1.4, 202);
  mc.ctx.setTransform(1, 0, 0, 1, 0, 0);
  mc.ctx.drawImage(paint.c.canvas, 0, 0);
  return layoutSet(mc, null);
}

/** Panelized concrete base shared by landing/platform: panel tones + sawcut joints. */
function concretePanels(mc: MeterCanvas, cols: number, rowLen: number, seed: number, jointWidth: number): void {
  const rng = mulberry32(seed);
  const colW = mc.widthM / cols;
  const rows = Math.round(mc.periodM / rowLen);
  const ctx = mc.ctx;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = (rng() - 0.5) * 0.045;
      ctx.fillStyle = k > 0 ? `rgba(255,255,250,${k})` : `rgba(40,38,34,${-k})`;
      ctx.fillRect(c * colW, r * rowLen, colW, rowLen);
    }
  }
  // joints: dark groove with a faint lit lip
  const jw = jointWidth;
  for (let c = 0; c <= cols; c++) {
    const x = c * colW;
    mc.rect(x - jw / 2, 0, jw, mc.periodM, 'rgba(70,66,60,0.6)');
    mc.rect(x + jw / 2, 0, jw * 0.6, mc.periodM, 'rgba(255,255,255,0.1)');
  }
  for (let r = 0; r <= rows; r++) {
    const y = r * rowLen;
    mc.rect(0, y - jw / 2, mc.widthM, jw, 'rgba(70,66,60,0.6)');
    mc.rect(0, y + jw / 2, mc.widthM, jw * 0.6, 'rgba(255,255,255,0.1)');
  }
}

function landingLayout(): LayoutTextures {
  const W = 24;
  const P = 48;
  const mc = new MeterCanvas(W, P, 1024, 2048);
  fillMacro(mc, '#a9a49b', 0.045, 301, 4);
  mc.reset();
  concretePanels(mc, 4, 6, 302, 0.035);
  // rubber marks from touchdowns (subtle, along the center)
  const rng = mulberry32(303);
  for (let i = 0; i < 11; i++) {
    const x = W / 2 + (rng() - 0.5) * 7;
    band(mc, x, 0.35 + rng() * 0.4, 'rgba(20,20,22,1)', 0.05 + rng() * 0.07);
  }
  const paint = new MeterCanvas(W, P, 1024, 2048);
  edgeLines(paint, PAINT);
  // touchdown zone: a 3-bar set, then a 2-bar set (decreasing, like a runway TDZ), per period
  for (const side of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const off = 2.2 + k * 1.3;
      const x = side < 0 ? W / 2 - off - 0.8 : W / 2 + off;
      paint.rect(x, 3, 0.8, 7.5, PAINT);
      if (k < 2) paint.rect(x, 27, 0.8, 7.5, PAINT);
    }
  }
  // dashed center line between the bar sets
  for (let y = 0; y < P; y += 8) paint.rect(W / 2 - 0.12, y + 12.5, 0.24, 3.5, rgba(PAINT, 0.9));
  wearPaint(paint.c, 1.2, 304);
  mc.ctx.setTransform(1, 0, 0, 1, 0, 0);
  mc.ctx.drawImage(paint.c.canvas, 0, 0);
  return layoutSet(mc, null);
}

function adhesiveLayout(): LayoutTextures {
  const W = 14;
  const P = 8;
  const mc = new MeterCanvas(W, P, 1024, 512);
  fillMacro(mc, '#c3c3bf', 0.06, 401, 3);
  mc.reset();
  // faint cyan micro-grid (1 m), slightly stronger every 4 m — a fine engraved texture that only
  // reads up close; from the chase camera the deck must stay plain light-grey concrete
  const gridCol = (k: number) => (k % 4 === 0 ? rgba(PALETTE.cyanDeep, 0.2) : rgba(PALETTE.cyanDeep, 0.1));
  for (let x = 1; x < W; x++) if (Math.abs(x - W / 2) > 0.5) mc.rect(x - 0.009, 0, 0.018, P, gridCol(x));
  for (let y = 0; y < P; y++) mc.rect(0.6, y - 0.009, W - 1.2, 0.018, gridCol(y));
  // white center line
  const paint = new MeterCanvas(W, P, 1024, 512);
  paint.rect(W / 2 - 0.16, 0, 0.32, P, PAINT);
  wearPaint(paint.c, 0.5, 402);
  mc.ctx.setTransform(1, 0, 0, 1, 0, 0);
  mc.ctx.drawImage(paint.c.canvas, 0, 0);

  const em = new MeterCanvas(W, P, 1024, 512);
  em.ctx.fillStyle = '#000';
  em.ctx.fillRect(0, 0, W, P);
  for (let x = 1; x < W; x++) if (Math.abs(x - W / 2) > 0.5) em.rect(x - 0.01, 0, 0.02, P, x % 4 === 0 ? '#a0a0a0' : '#606060');
  for (let y = 0; y < P; y++) em.rect(0.6, y - 0.01, W - 1.2, 0.02, y % 4 === 0 ? '#a0a0a0' : '#606060');
  return layoutSet(mc, em);
}

function platformLayout(): LayoutTextures {
  const W = 24;
  const P = 16;
  const mc = new MeterCanvas(W, P, 1024, 768);
  fillMacro(mc, '#aba69d', 0.05, 501, 3);
  mc.reset();
  concretePanels(mc, 3, 8, 502, 0.05);
  // titanium expansion joint strips on the long joints
  for (let c = 1; c < 3; c++) {
    const x = (c * W) / 3;
    mc.rect(x - 0.05, 0, 0.1, P, rgba(PALETTE.titanium300, 0.85));
    mc.rect(x - 0.05, 0, 0.02, P, 'rgba(40,40,40,0.5)');
  }
  return layoutSet(mc, null);
}

function metalLayout(): LayoutTextures {
  const W = 12;
  const P = 6;
  const mc = new MeterCanvas(W, P, 512, 256);
  fillMacro(mc, '#a8afb7', 0.035, 601, 3);
  mc.reset();
  const ctx = mc.ctx;
  const rng = mulberry32(602);
  // staggered plates 3 m x 2 m
  for (let r = 0; r < 3; r++) {
    const off = r % 2 === 0 ? 0 : 1.5;
    for (let c = -1; c < 5; c++) {
      const x = c * 3 + off;
      const k = (rng() - 0.5) * 0.08;
      ctx.fillStyle = k > 0 ? `rgba(255,255,255,${k})` : `rgba(0,0,0,${-k})`;
      ctx.fillRect(x, r * 2, 3, 2);
      mc.rect(x - 0.012, r * 2, 0.024, 2, 'rgba(30,32,36,0.8)');
      // fastener rows along plate ends
      ctx.fillStyle = 'rgba(40,42,46,0.65)';
      for (let k2 = 0.25; k2 < 2; k2 += 0.35) {
        mc.wrapY((dy) => {
          ctx.beginPath();
          ctx.arc(x + 0.12, r * 2 + k2 + dy, 0.025, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    }
    mc.rect(0, r * 2 - 0.012, W, 0.024, 'rgba(30,32,36,0.8)');
  }
  return layoutSet(mc, null);
}

function glassLayout(): LayoutTextures {
  const W = 8;
  const P = 4;
  const mc = new MeterCanvas(W, P, 256, 128);
  const ctx = mc.ctx;
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, '#0d131a');
  g.addColorStop(0.5, '#0a0f15');
  g.addColorStop(1, '#0d131a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, P);
  for (const x of [0, W / 2, W]) mc.rect(x - 0.05, 0, 0.1, P, PALETTE.titanium400);
  mc.rect(0, -0.05, W, 0.1, PALETTE.titanium400);
  return layoutSet(mc, null);
}

const LAYOUTS: Record<TrackStyle, () => LayoutTextures> = {
  runway: runwayLayout,
  ramp: rampLayout,
  landing: landingLayout,
  adhesive: adhesiveLayout,
  platform: platformLayout,
  metal: metalLayout,
  glass: glassLayout,
};

/** Layout (markings) texture set for a track style. Cached. */
export function getLayoutTextures(style: TrackStyle): LayoutTextures {
  return cached(`layout:${style}`, LAYOUTS[style]);
}

/* ------------------------------------------------------------------ */
/* Field variants (wide box tops)                                      */
/* ------------------------------------------------------------------ */
// Layouts with LINEAR markings (edge lines, lanes, center lines, touchdown bars, chevrons) are
// authored for one strip of road; tiled across a 200 m arena box they read as an eight-lane
// highway. Wide boxes use these marking-free fields instead: same surface (macro tone, panels,
// micro-grid), seamless in u AND v. Generated lazily, only when a wide box needs them.

/** Graphite asphalt apron (runway / ramp styles): macro tone only, the detail map does the rest. */
function asphaltField(): LayoutTextures {
  const mc = new MeterCanvas(26, 26, 1024, 1024);
  fillMacro(mc, '#2e3136', 0.08, 111, 4);
  return layoutSet(mc, null);
}

/** Cast-concrete landing apron: the landing deck's panels without paint. */
function landingField(): LayoutTextures {
  const mc = new MeterCanvas(24, 24, 1024, 1024);
  fillMacro(mc, '#a9a49b', 0.045, 311, 4);
  mc.reset();
  concretePanels(mc, 4, 6, 312, 0.035);
  return layoutSet(mc, null);
}

/** Polished adhesive concrete: the full 1 m micro-grid (offset half a cell so no line crosses a seam), no center line. */
function adhesiveField(): LayoutTextures {
  const W = 16;
  const P = 16;
  const mc = new MeterCanvas(W, P, 1024, 1024);
  fillMacro(mc, '#c3c3bf', 0.06, 411, 3);
  mc.reset();
  const em = new MeterCanvas(W, P, 1024, 1024);
  em.ctx.fillStyle = '#000';
  em.ctx.fillRect(0, 0, W, P);
  for (let k = 0; k < W; k++) {
    const major = k % 4 === 0;
    const col = rgba(PALETTE.cyanDeep, major ? 0.2 : 0.1);
    const glow = major ? '#a0a0a0' : '#606060';
    mc.rect(k + 0.5 - 0.009, 0, 0.018, P, col);
    mc.rect(0, k + 0.5 - 0.009, W, 0.018, col);
    em.rect(k + 0.5 - 0.01, 0, 0.02, P, glow);
    em.rect(0, k + 0.5 - 0.01, W, 0.02, glow);
  }
  return layoutSet(mc, em);
}

const FIELD_LAYOUTS: Partial<Record<TrackStyle, { key: string; make: () => LayoutTextures }>> = {
  runway: { key: 'asphalt', make: asphaltField },
  ramp: { key: 'asphalt', make: asphaltField },
  landing: { key: 'landing', make: landingField },
  adhesive: { key: 'adhesive', make: adhesiveField },
};

/** True when a style has linear markings and therefore a marking-free field variant. */
export function hasFieldLayout(style: TrackStyle): boolean {
  return FIELD_LAYOUTS[style] !== undefined;
}

/**
 * Marking-free variant of a style's layout for wide box tops (seamless in both axes; repeat it
 * every `nominalWidth` across). Null for styles without linear markings (platform, metal, glass).
 * Cached.
 */
export function getFieldLayoutTextures(style: TrackStyle): LayoutTextures | null {
  const f = FIELD_LAYOUTS[style];
  return f ? cached(`layoutField:${f.key}`, f.make) : null;
}

/* ------------------------------------------------------------------ */
/* Slab fascia, LED diffuser                                           */
/* ------------------------------------------------------------------ */

export interface FasciaTextures {
  map: CanvasTexture;
  /** Tile size (m) along u and v (metric side UVs: u = arc length, v = depth below the deck). */
  tileU: number;
  tileV: number;
}

/**
 * Architectural concrete fascia for slab sides/undersides: formwork joints every 3 m, tie holes,
 * a crisp reveal groove 15 cm below the drive surface, faint vertical weathering streaks.
 */
export function getFasciaTextures(): FasciaTextures {
  return cached('fascia', () => {
    // tall period so the underside (v = 2 .. 15) never repeats the reveal groove
    const U = 12;
    const V = 16;
    const mc = new MeterCanvas(U, V, 768, 1024);
    fillMacro(mc, '#9c978e', 0.05, 701, 4);
    mc.reset();
    const ctx = mc.ctx;
    const rng = mulberry32(702);
    // weathering streaks from the top edge
    for (let i = 0; i < 40; i++) {
      const x = rng() * U;
      const len = 0.3 + rng() * 1.4;
      const g = ctx.createLinearGradient(0, 0.2, 0, 0.2 + len);
      g.addColorStop(0, 'rgba(30,28,25,0.10)');
      g.addColorStop(1, 'rgba(30,28,25,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, 0.2, 0.04 + rng() * 0.12, len);
    }
    // formwork panel joints
    for (let x = 0; x <= U; x += 3) {
      ctx.fillStyle = 'rgba(60,56,50,0.55)';
      ctx.fillRect(x - 0.012, 0.2, 0.024, V);
    }
    // tie holes
    ctx.fillStyle = 'rgba(45,42,38,0.7)';
    for (let x = 0.75; x < U; x += 1.5) {
      for (const y of [0.62, 2.1]) {
        ctx.beginPath();
        ctx.ellipse(x, y, 0.035, 0.035, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // reveal groove below the deck edge
    ctx.fillStyle = 'rgba(40,38,34,0.75)';
    ctx.fillRect(0, 0.14, U, 0.035);
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(0, 0.175, U, 0.015);
    const map = makeTexture(mc.c.canvas, { color: true, channel: 0 });
    map.repeat.set(1 / U, 1 / V);
    return { map, tileU: U, tileV: V };
  });
}

/** LED diffuser pattern: discrete LED dots (5 cm pitch) over a softly lit strip. Non-color multiplier. */
export function getLedDotTexture(): CanvasTexture {
  return cached('ledDots', () => {
    const c = createCanvas(32, 16);
    const ctx = c.ctx;
    ctx.fillStyle = 'rgb(150,150,150)';
    ctx.fillRect(0, 0, 32, 16);
    const g = ctx.createRadialGradient(16, 8, 0, 16, 8, 9);
    g.addColorStop(0, 'rgb(255,255,255)');
    g.addColorStop(0.55, 'rgb(235,235,235)');
    g.addColorStop(1, 'rgb(150,150,150)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 16);
    const tex = makeTexture(c.canvas, { color: false, channel: 0 });
    tex.repeat.set(20, 1); // u = meters -> 5 cm pitch
    return tex;
  });
}
