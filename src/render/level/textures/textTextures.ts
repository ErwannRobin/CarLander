/**
 * Canvas text rendering for in-world signage (Michroma display face, warm white on dark glass).
 * Fonts must be loaded before drawing: every drawer awaits `ensureFonts()`.
 */
import { CanvasTexture } from 'three';
import { PALETTE } from '@/render/palette';
import { createCanvas, makeTexture, rgba } from './canvasUtils';

export const DISPLAY_FONT = 'Michroma';
export const UI_FONT = 'Inter Variable';

let fontsReady: Promise<void> | null = null;

/** Resolves when the display/UI faces are usable by canvas (never rejects). */
export function ensureFonts(): Promise<void> {
  if (!fontsReady) {
    fontsReady =
      typeof document === 'undefined' || !document.fonts
        ? Promise.resolve()
        : Promise.all([
            document.fonts.load(`400 64px ${DISPLAY_FONT}`),
            document.fonts.load(`600 64px "${UI_FONT}"`),
          ])
            .then(() => undefined)
            .catch(() => undefined);
  }
  return fontsReady;
}

const SUPPORTS_LETTER_SPACING =
  typeof CanvasRenderingContext2D !== 'undefined' && 'letterSpacing' in CanvasRenderingContext2D.prototype;

/** Draws text with letter tracking (em) and returns the drawn width. Uses ctx.letterSpacing when supported. */
export function drawTracked(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  trackingEm: number,
  fontPx: number,
  align: 'left' | 'center' | 'right' = 'left',
): number {
  const spacing = trackingEm * fontPx;
  ctx.textAlign = 'left';
  if (SUPPORTS_LETTER_SPACING) {
    ctx.letterSpacing = `${spacing}px`;
    // measureText includes trailing spacing after the last glyph
    const w = ctx.measureText(text).width - spacing;
    const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    ctx.fillText(text, x0, y);
    ctx.letterSpacing = '0px';
    return w;
  }
  const widths = [...text].map((ch) => ctx.measureText(ch).width);
  const w = widths.reduce((a, b) => a + b, 0) + spacing * Math.max(0, text.length - 1);
  let cx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  [...text].forEach((ch, i) => {
    ctx.fillText(ch, cx, y);
    cx += widths[i] + spacing;
  });
  return w;
}

export function measureTracked(ctx: CanvasRenderingContext2D, text: string, trackingEm: number, fontPx: number): number {
  const spacing = trackingEm * fontPx;
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width;
  return w + spacing * Math.max(0, text.length - 1);
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/* ------------------------------------------------------------------ */
/* Key caps                                                             */
/* ------------------------------------------------------------------ */

const KEY_GLYPHS: Record<string, string> = {
  ARROWUP: '↑',
  ARROWDOWN: '↓',
  ARROWLEFT: '←',
  ARROWRIGHT: '→',
  UP: '↑',
  DOWN: '↓',
  LEFT: '←',
  RIGHT: '→',
};

/** Normalizes a display key name ("KeyW" -> "W", "ShiftLeft" -> "SHIFT", "Space" -> "SPACE"). */
export function keyLabel(key: string): string {
  let k = key.trim();
  if (/^Key[A-Z]$/.test(k)) k = k.slice(3);
  else if (/^Digit\d$/.test(k)) k = k.slice(5);
  else if (/^(Shift|Control|Alt|Meta)(Left|Right)$/.test(k)) k = k.replace(/(Left|Right)$/, '');
  const up = k.toUpperCase();
  return KEY_GLYPHS[up] ?? (up === 'CONTROL' ? 'CTRL' : up === 'ESCAPE' ? 'ESC' : up);
}

/** Draws a key cap at (x, y) with height h; returns its width. */
export function drawKeyCap(ctx: CanvasRenderingContext2D, label: string, x: number, y: number, h: number, measureOnly = false): number {
  const fontPx = Math.round(h * 0.42);
  ctx.font = `600 ${fontPx}px "${UI_FONT}", system-ui, sans-serif`;
  const textW = measureTracked(ctx, label, 0.08, fontPx);
  const w = Math.max(h, textW + h * 0.62);
  if (measureOnly) return w;
  const r = h * 0.16;
  // cap body: subtle vertical gradient, hairline titanium border, inner top highlight
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, 'rgba(58,64,72,0.95)');
  g.addColorStop(1, 'rgba(30,34,40,0.95)');
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = Math.max(2, h * 0.035);
  ctx.strokeStyle = rgba(PALETTE.titanium200, 0.75);
  ctx.stroke();
  roundRect(ctx, x + h * 0.06, y + h * 0.06, w - h * 0.12, h * 0.1, r * 0.5);
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fill();
  ctx.fillStyle = PALETTE.warmWhite;
  ctx.textBaseline = 'middle';
  drawTracked(ctx, label, x + w / 2, y + h * 0.53, 0.08, fontPx, 'center');
  return w;
}

/* ------------------------------------------------------------------ */
/* Sign panels                                                          */
/* ------------------------------------------------------------------ */

export interface SignContent {
  /** Main line (Michroma, uppercase recommended). */
  title: string;
  /** Optional key caps + label line (e.g. ["SPACE"], "Thrusters"). */
  keys?: string[];
  keyLabel?: string;
  /** Accent rule color. Default cyan. */
  accent?: string;
}

export interface SignTexture {
  texture: CanvasTexture;
  /** width / height of the drawn panel. */
  aspect: number;
}

/**
 * Premium dark-glass panel: rounded rect with a vertical sheen, hairline titanium border, a thin
 * accent rule, the title in tracked Michroma and an optional key-cap row. Drawn at 1024 px wide.
 */
export function drawSignPanel(content: SignContent): SignTexture {
  const W = 1024;
  const pad = 64;
  const titlePx = 64;
  const keyH = content.keys && content.keys.length > 0 ? 96 : 0;
  const H = Math.round(pad * 1.25 + titlePx * 1.2 + (keyH ? keyH + 44 : 0) + pad * 0.95);
  const { canvas, ctx } = createCanvas(W, H);
  // glass body
  const body = ctx.createLinearGradient(0, 0, 0, H);
  body.addColorStop(0, 'rgba(26,30,36,0.92)');
  body.addColorStop(0.5, 'rgba(16,19,23,0.9)');
  body.addColorStop(1, 'rgba(12,14,17,0.94)');
  roundRect(ctx, 4, 4, W - 8, H - 8, 26);
  ctx.fillStyle = body;
  ctx.fill();
  // diagonal sheen
  ctx.save();
  roundRect(ctx, 4, 4, W - 8, H - 8, 26);
  ctx.clip();
  const sheen = ctx.createLinearGradient(0, 0, W * 0.6, H * 1.4);
  sheen.addColorStop(0, 'rgba(255,255,255,0.10)');
  sheen.addColorStop(0.35, 'rgba(255,255,255,0.02)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
  // border
  roundRect(ctx, 4, 4, W - 8, H - 8, 26);
  ctx.lineWidth = 3;
  ctx.strokeStyle = rgba(PALETTE.titanium300, 0.55);
  ctx.stroke();
  // accent rule
  const accent = content.accent ?? PALETTE.cyan;
  ctx.fillStyle = accent;
  ctx.fillRect(pad, pad * 0.62, 72, 5);
  ctx.fillStyle = rgba(accent, 0.35);
  ctx.fillRect(pad + 84, pad * 0.62 + 1, 22, 3);
  // title
  ctx.fillStyle = PALETTE.warmWhite;
  ctx.textBaseline = 'alphabetic';
  let px = titlePx;
  ctx.font = `400 ${px}px ${DISPLAY_FONT}, sans-serif`;
  const maxW = W - pad * 2;
  while (measureTracked(ctx, content.title, 0.16, px) > maxW && px > 28) {
    px -= 2;
    ctx.font = `400 ${px}px ${DISPLAY_FONT}, sans-serif`;
  }
  const titleY = pad * 1.25 + titlePx;
  drawTracked(ctx, content.title, pad, titleY, 0.16, px);
  // key row
  if (keyH && content.keys) {
    let x = pad;
    const y = titleY + 44;
    content.keys.forEach((k, i) => {
      if (i > 0) {
        ctx.font = `400 40px ${DISPLAY_FONT}, sans-serif`;
        ctx.fillStyle = rgba(PALETTE.titanium300, 0.9);
        ctx.textBaseline = 'middle';
        ctx.fillText('+', x + 10, y + keyH / 2);
        x += 52;
      }
      x += drawKeyCap(ctx, keyLabel(k), x, y, keyH) + 14;
    });
    if (content.keyLabel) {
      ctx.font = `500 46px "${UI_FONT}", system-ui, sans-serif`;
      ctx.fillStyle = rgba(PALETTE.titanium200, 0.95);
      ctx.textBaseline = 'middle';
      drawTracked(ctx, content.keyLabel.toUpperCase(), x + 24, y + keyH / 2 + 2, 0.12, 46);
    }
  }
  const texture = makeTexture(canvas, { color: true, repeat: false, flipY: true });
  return { texture, aspect: W / H };
}

export interface BillboardContent {
  title: string;
  subtitle?: string;
  /** Small right-aligned index / tag (e.g. "01", "500 M"). */
  tag?: string;
  /** Accent color. Default cyan. */
  accent?: string;
  /** Board aspect (width / height). */
  aspect: number;
}

/** Large facility billboard face: dark glass, tracked Michroma title, subtitle, accent bar and tag. */
export function drawBillboard(c: BillboardContent): CanvasTexture {
  const W = 2048;
  const H = Math.max(256, Math.round(W / c.aspect));
  const { canvas, ctx } = createCanvas(W, H);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#1c2026');
  g.addColorStop(1, '#101317');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const sheen = ctx.createLinearGradient(0, 0, W, H);
  sheen.addColorStop(0, 'rgba(255,255,255,0.07)');
  sheen.addColorStop(0.4, 'rgba(255,255,255,0.0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, W, H);
  const accent = c.accent ?? PALETTE.cyan;
  const pad = H * 0.16;
  ctx.fillStyle = accent;
  ctx.fillRect(pad, pad, H * 0.035, H - pad * 2);
  const x = pad + H * 0.12;
  const hasSub = !!c.subtitle;
  let titlePx = Math.round(H * (hasSub ? 0.3 : 0.38));
  ctx.font = `400 ${titlePx}px ${DISPLAY_FONT}, sans-serif`;
  const maxW = W - x - pad - (c.tag ? H * 0.9 : 0);
  while (measureTracked(ctx, c.title, 0.2, titlePx) > maxW && titlePx > 20) {
    titlePx -= 4;
    ctx.font = `400 ${titlePx}px ${DISPLAY_FONT}, sans-serif`;
  }
  ctx.fillStyle = PALETTE.warmWhite;
  ctx.textBaseline = 'alphabetic';
  const titleY = hasSub ? H * 0.53 : H * 0.5 + titlePx * 0.36;
  drawTracked(ctx, c.title, x, titleY, 0.2, titlePx);
  if (c.subtitle) {
    const subPx = Math.round(H * 0.11);
    ctx.font = `500 ${subPx}px "${UI_FONT}", system-ui, sans-serif`;
    ctx.fillStyle = rgba(PALETTE.titanium200, 0.9);
    drawTracked(ctx, c.subtitle.toUpperCase(), x + titlePx * 0.04, H * 0.53 + subPx * 1.9, 0.3, subPx);
  }
  if (c.tag) {
    const tagPx = Math.round(H * 0.16);
    ctx.font = `400 ${tagPx}px ${DISPLAY_FONT}, sans-serif`;
    ctx.fillStyle = accent;
    drawTracked(ctx, c.tag, W - pad, H * 0.5 + tagPx * 0.36, 0.15, tagPx, 'right');
  }
  ctx.strokeStyle = rgba(PALETTE.titanium300, 0.35);
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, W - 4, H - 4);
  return makeTexture(canvas, { color: true, repeat: false, flipY: true });
}

export interface LabelOptions {
  text: string;
  /** Font size in px on the canvas (resolution). Default 160. */
  fontPx?: number;
  trackingEm?: number;
  color?: string;
  /** Background fill (CSS) or null for transparent. */
  background?: string | null;
  /** Horizontal padding in em. Default 0.6. */
  padEm?: number;
  /** Optional thin accent rule under the text. */
  rule?: string | null;
}

/** Single-line tracked Michroma label (FINISH, billboards). */
export function drawLabel(opts: LabelOptions): SignTexture {
  const fontPx = opts.fontPx ?? 160;
  const tracking = opts.trackingEm ?? 0.32;
  const probe = createCanvas(8, 8).ctx;
  probe.font = `400 ${fontPx}px ${DISPLAY_FONT}, sans-serif`;
  const textW = measureTracked(probe, opts.text, tracking, fontPx);
  const pad = fontPx * (opts.padEm ?? 0.6);
  const W = Math.min(4096, Math.ceil(textW + pad * 2));
  const H = Math.ceil(fontPx * 1.9);
  const { canvas, ctx } = createCanvas(W, H);
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.font = `400 ${fontPx}px ${DISPLAY_FONT}, sans-serif`;
  ctx.fillStyle = opts.color ?? PALETTE.warmWhite;
  ctx.textBaseline = 'middle';
  drawTracked(ctx, opts.text, W / 2, H * 0.5, tracking, fontPx, 'center');
  if (opts.rule) {
    ctx.fillStyle = opts.rule;
    ctx.fillRect(W / 2 - fontPx * 0.6, H * 0.86, fontPx * 1.2, Math.max(3, fontPx * 0.03));
  }
  const texture = makeTexture(canvas, { color: true, repeat: false, flipY: true });
  return { texture, aspect: W / H };
}
