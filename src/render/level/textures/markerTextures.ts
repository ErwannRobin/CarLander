/**
 * Target zone marker artwork: concentric precision rings, a graduated bezel and a cyan bullseye.
 * The canvas maps the unit disc [-1, 1]^2 (u right, v forward with flipY = false). Ring radii match
 * the zone's radial metric: 0.25 = BULLSEYE (inner 25%), 0.5, 0.75 and the zone edge at 1.
 */
import type { CanvasTexture } from 'three';
import { PALETTE } from '@/render/palette';
import { onLevelMaterialsDispose } from '../materials';
import { createCanvas, makeTexture, rgba } from './canvasUtils';
import { DISPLAY_FONT, drawTracked, measureTracked } from './textTextures';

export interface TargetTextures {
  map: CanvasTexture;
  emissive: CanvasTexture;
}

let cachedTarget: TargetTextures | null = null;

export function getTargetTextures(): TargetTextures {
  if (cachedTarget) return cachedTarget;
  const S = 1024;
  const R = S / 2;
  const color = createCanvas(S, S);
  const glow = createCanvas(S, S);
  for (const [cv, isGlow] of [
    [color, false],
    [glow, true],
  ] as const) {
    const ctx = cv.ctx;
    ctx.clearRect(0, 0, S, S);
    if (isGlow) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, S, S);
    }
    ctx.translate(R, R);
    ctx.scale(R, R); // unit disc space
    const white = isGlow ? 'rgba(120,120,120,1)' : rgba(PALETTE.warmWhite, 0.92);
    const whiteSoft = isGlow ? 'rgba(70,70,70,1)' : rgba(PALETTE.warmWhite, 0.55);
    const cyan = isGlow ? '#ffffff' : PALETTE.cyan;
    const ring = (r: number, w: number, style: string) => {
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.lineWidth = w;
      ctx.strokeStyle = style;
      ctx.stroke();
    };
    // outer edge ring (double line) + graduated bezel
    ring(0.975, 0.02, white);
    ring(0.935, 0.006, whiteSoft);
    for (let d = 0; d < 360; d += 5) {
      const a = (d * Math.PI) / 180;
      const major = d % 30 === 0;
      const r0 = major ? 0.86 : 0.895;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      ctx.lineTo(Math.cos(a) * 0.93, Math.sin(a) * 0.93);
      ctx.lineWidth = major ? 0.008 : 0.004;
      ctx.strokeStyle = major ? white : whiteSoft;
      ctx.stroke();
    }
    // cardinal notches (forward notch is a cyan chevron pointing along +v = travel direction)
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      ctx.save();
      ctx.rotate(a);
      ctx.fillStyle = k === 1 ? cyan : white;
      ctx.beginPath();
      ctx.moveTo(0.995, 0);
      ctx.lineTo(0.9, 0.035);
      ctx.lineTo(0.9, -0.035);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    // intermediate rings
    ring(0.75, 0.012, white);
    ring(0.5, 0.014, white);
    // bullseye: tinted fill, cyan ring, fine inner ring, center dot, crosshair
    if (!isGlow) {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 0.25);
      g.addColorStop(0, rgba(PALETTE.cyan, 0.22));
      g.addColorStop(1, rgba(PALETTE.cyan, 0.1));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 0.25, 0, Math.PI * 2);
      ctx.fill();
    }
    ring(0.25, 0.018, cyan);
    ring(0.13, 0.005, isGlow ? 'rgba(140,140,140,1)' : rgba(PALETTE.cyanGlow, 0.7));
    ctx.fillStyle = cyan;
    ctx.beginPath();
    ctx.arc(0, 0, 0.028, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 0.004;
    ctx.strokeStyle = whiteSoft;
    for (const [x0, y0, x1, y1] of [
      [-0.47, 0, -0.29, 0],
      [0.29, 0, 0.47, 0],
      [0, -0.47, 0, -0.29],
      [0, 0.29, 0, 0.47],
    ]) {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  const map = makeTexture(color.canvas, { color: true, repeat: false });
  const emissive = makeTexture(glow.canvas, { color: true, repeat: false });
  cachedTarget = { map, emissive };
  return cachedTarget;
}

export interface ZoneBandOptions {
  /** Lettering (Michroma), e.g. "RELEASE". Omit for bars + chevrons only. Fonts must be loaded. */
  label?: string;
  /** Zone length / width (v extent over u extent) — keeps the artwork undistorted. */
  aspect: number;
  /** Fraction of the zone width actually covered by the deck (lettering is fitted inside it). */
  deckFraction?: number;
  accent?: string;
}

/**
 * Action-zone deck marking (per zone, NOT cached — the caller owns and disposes both textures).
 * Same unit mapping as the target: u = 0..1 across the zone (right), v = 0..1 along it with +v =
 * the zone's forward / travel direction (flipY = false). Entry / exit bars, a faint wash, cyan
 * chevrons pointing forward and road-style lettering elongated 2x along v so it reads at the
 * grazing angle of an approaching car (drawn mirrored in v, which un-mirrors it for a viewer
 * looking forward along the deck — also on inverted decks, where the camera follows the surface).
 */
export function drawZoneBand(o: ZoneBandOptions): TargetTextures {
  const W = 1024;
  const H = Math.round(Math.min(2048, Math.max(256, W * o.aspect)));
  const accent = o.accent ?? PALETTE.cyan;
  const deck = Math.min(1, Math.max(0.2, o.deckFraction ?? 1));
  const color = createCanvas(W, H);
  const glow = createCanvas(W, H);
  const x0 = (W * (1 - deck)) / 2;
  const x1 = W - x0;
  for (const [cv, isGlow] of [
    [color, false],
    [glow, true],
  ] as const) {
    const ctx = cv.ctx;
    if (isGlow) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
    } else {
      // faint wash over the deck part of the zone
      ctx.fillStyle = rgba(PALETTE.warmWhite, 0.07);
      ctx.fillRect(x0, 0, x1 - x0, H);
    }
    const white = isGlow ? 'rgb(110,110,110)' : rgba(PALETTE.warmWhite, 0.92);
    const cyan = isGlow ? '#ffffff' : accent;
    // entry / exit bars (solid) with a thin companion line inside the zone
    const bar = Math.max(10, H * 0.022);
    ctx.fillStyle = white;
    ctx.fillRect(x0, 0, x1 - x0, bar);
    ctx.fillRect(x0, H - bar, x1 - x0, bar);
    ctx.fillStyle = cyan;
    ctx.fillRect(x0, bar * 2, x1 - x0, bar * 0.28);
    ctx.fillRect(x0, H - bar * 2 - bar * 0.28, x1 - x0, bar * 0.28);
    // forward chevrons on the centerline (apex towards +v), before and after the lettering
    const cw = (x1 - x0) * 0.16;
    const ch = cw * 0.55;
    const chevron = (yApex: number) => {
      ctx.beginPath();
      ctx.moveTo(W / 2 - cw, yApex - ch);
      ctx.lineTo(W / 2, yApex);
      ctx.lineTo(W / 2 + cw, yApex - ch);
      ctx.lineWidth = cw * 0.2;
      ctx.lineJoin = 'miter';
      ctx.strokeStyle = cyan;
      ctx.stroke();
    };
    const hasLabel = !!o.label;
    const yMid = H / 2;
    const textH = Math.min(H * 0.34, (x1 - x0) * 0.32);
    const gap = hasLabel ? textH / 2 + ch * 1.6 : ch * 0.6;
    for (const s of [-1, 1]) {
      for (let k = 0; k < 2; k++) chevron(yMid + s * (gap + k * ch * 1.15) + ch * 0.5);
    }
    if (hasLabel && o.label) {
      // fit the tracked word inside the deck width, then stretch 2x along v (road lettering)
      let px = Math.round(textH / 2);
      ctx.font = `400 ${px}px ${DISPLAY_FONT}, sans-serif`;
      const maxW = (x1 - x0) * 0.86;
      while (measureTracked(ctx, o.label, 0.18, px) > maxW && px > 12) {
        px -= 2;
        ctx.font = `400 ${px}px ${DISPLAY_FONT}, sans-serif`;
      }
      ctx.save();
      ctx.translate(W / 2, yMid);
      ctx.scale(1, -2);
      ctx.fillStyle = isGlow ? 'rgb(200,200,200)' : rgba(PALETTE.warmWhite, 0.95);
      ctx.textBaseline = 'middle';
      drawTracked(ctx, o.label, 0, 0, 0.18, px, 'center');
      ctx.restore();
    }
  }
  return {
    map: makeTexture(color.canvas, { color: true, repeat: false }),
    emissive: makeTexture(glow.canvas, { color: true, repeat: false }),
  };
}

export function disposeMarkerTextures(): void {
  if (!cachedTarget) return;
  cachedTarget.map.dispose();
  cachedTarget.emissive.dispose();
  cachedTarget = null;
}

// part of the module-wide teardown (disposeLevelMaterials)
onLevelMaterialsDispose(disposeMarkerTextures);
