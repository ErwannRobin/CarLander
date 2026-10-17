/**
 * Course markers (render only, outside the driving / flight envelope):
 *  - DistanceBoards: dark-glass boards cantilevered off the runway fascia counting down to the kicker
 *    (one shared texture atlas, merged meshes)
 *  - Beacons: slender titanium masts with a cyan light band (the lip; the start of the target rings) —
 *    tall enough to rise above the apron crest, so they frame the landing area from the lip
 *  - EdgePosts: low posts with cyan caps along both deck edges beside the target rings
 */
import { useEffect } from 'react';
import { Group, Matrix4, MeshStandardMaterial, Vector3, type CanvasTexture } from 'three';
import type { V3 } from '@/game/types';
import { Billboard, getLevelMaterials } from '@/render/level';
import { chamferRect, GeoBuilder, taperedPrism } from '@/render/level/geometry/GeoBuilder';
import { createCanvas, makeTexture, rgba } from '@/render/level/textures/canvasUtils';
import { DISPLAY_FONT, drawTracked, ensureFonts } from '@/render/level/textures/textTextures';
import { PALETTE } from '@/render/palette';
import { meshOf, useBuilt, type Disposable } from './useBuilt';

/* ------------------------------------------------------------------ */
/* Distance boards                                                     */
/* ------------------------------------------------------------------ */

export interface DistanceBoard {
  z: number;
  text: string;
  /** Runway half width at the board (m). */
  halfWidth: number;
}

const BOARD_W = 6.4;
const BOARD_H = 2.9;
const BOARD_GAP = 3.2; // board inner edge, meters outside the runway edge
const BOARD_Y = 1.3; // bottom edge above the runway surface
const ATLAS_W = 1024;
const ROW_H = Math.round(ATLAS_W / (BOARD_W / BOARD_H));

/** Dark-glass board faces (facility billboard style) for every distinct label, stacked in one atlas. */
function drawBoardAtlas(labels: string[]): CanvasTexture {
  const { canvas, ctx } = createCanvas(ATLAS_W, ROW_H * labels.length);
  labels.forEach((label, i) => {
    const y0 = i * ROW_H;
    const g = ctx.createLinearGradient(0, y0, 0, y0 + ROW_H);
    g.addColorStop(0, '#1c2026');
    g.addColorStop(1, '#101317');
    ctx.fillStyle = g;
    ctx.fillRect(0, y0, ATLAS_W, ROW_H);
    const sheen = ctx.createLinearGradient(0, y0, ATLAS_W, y0 + ROW_H);
    sheen.addColorStop(0, 'rgba(255,255,255,0.07)');
    sheen.addColorStop(0.4, 'rgba(255,255,255,0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, y0, ATLAS_W, ROW_H);
    const pad = ROW_H * 0.16;
    ctx.fillStyle = PALETTE.cyan;
    ctx.fillRect(pad, y0 + pad, ROW_H * 0.035, ROW_H - pad * 2);
    const px = Math.round(ROW_H * 0.42);
    ctx.font = `400 ${px}px ${DISPLAY_FONT}, sans-serif`;
    ctx.fillStyle = PALETTE.warmWhite;
    ctx.textBaseline = 'alphabetic';
    drawTracked(ctx, label, pad + ROW_H * 0.12, y0 + ROW_H * 0.5 + px * 0.36, 0.2, px);
    const tagPx = Math.round(ROW_H * 0.16);
    ctx.font = `400 ${tagPx}px ${DISPLAY_FONT}, sans-serif`;
    ctx.fillStyle = PALETTE.cyan;
    drawTracked(ctx, 'M', ATLAS_W - pad, y0 + ROW_H * 0.5 + tagPx * 0.36, 0.15, tagPx, 'right');
    ctx.strokeStyle = rgba(PALETTE.titanium300, 0.35);
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, y0 + 1.5, ATLAS_W - 3, ROW_H - 3);
  });
  return makeTexture(canvas, { color: true, repeat: false, flipY: true });
}

/**
 * Boards cantilevered off the runway fascia on both sides, counting down to the kicker. All faces
 * share one texture atlas and one mesh (≈ 3 draw calls for every board together).
 */
export function DistanceBoards({ boards, deckY = 0 }: { boards: DistanceBoard[]; deckY?: number }) {
  const key = JSON.stringify(boards);
  const built = useBuilt(() => {
    const lib = getLevelMaterials();
    const owned: Disposable[] = [];
    const root = new Group();
    root.name = 'l1-distance-boards';
    const labels = [...new Set(boards.map((b) => b.text))];
    const steel = new GeoBuilder();
    const trims = new GeoBuilder();
    const faces = new GeoBuilder();
    const n = new Vector3(0, 0, 1);
    for (const b of boards) {
      const row = labels.indexOf(b.text);
      const v0 = 1 - (row + 1) / labels.length;
      const v1 = 1 - row / labels.length;
      for (const s of [-1, 1]) {
        const xc = s * (b.halfWidth + BOARD_GAP + BOARD_W / 2);
        const xEdge = s * (b.halfWidth + 0.2);
        const yc = deckY + BOARD_Y + BOARD_H / 2;
        // cantilever arm under the deck edge, then a post up to the board
        const armLen = Math.abs(xc - xEdge);
        taperedPrism(steel, chamferRect(armLen / 2, 0.22, 0.05), deckY - 1.05, deckY - 0.65, [1, 1], [1, 1], {
          matrix: new Matrix4().makeTranslation((xc + xEdge) / 2, 0, b.z - 0.15),
          capTop: true,
          capBottom: true,
        });
        taperedPrism(steel, chamferRect(0.2, 0.2, 0.05), deckY - 1.05, deckY + BOARD_Y + 0.2, [1.15, 1.15], [1, 1], {
          matrix: new Matrix4().makeTranslation(xc, 0, b.z - 0.35),
          capTop: true,
        });
        // frame + titanium trims
        taperedPrism(steel, chamferRect((BOARD_W + 0.3) / 2, 0.25, 0.08), yc - (BOARD_H + 0.3) / 2, yc + (BOARD_H + 0.3) / 2, [1, 1], [1, 1], {
          matrix: new Matrix4().makeTranslation(xc, 0, b.z),
          capTop: true,
          capBottom: true,
        });
        for (const ty of [yc + BOARD_H / 2 + 0.2, yc - BOARD_H / 2 - 0.2]) {
          taperedPrism(trims, chamferRect((BOARD_W + 0.5) / 2, 0.3, 0), ty - 0.05, ty + 0.05, [1, 1], [1, 1], {
            matrix: new Matrix4().makeTranslation(xc, 0, b.z),
            capTop: true,
            capBottom: true,
          });
        }
        // face (front = +Z, toward the approaching car)
        const zf = b.z + 0.262;
        const a = faces.vertex(new Vector3(xc - BOARD_W / 2, yc - BOARD_H / 2, zf), n, 0, v0);
        const c = faces.vertex(new Vector3(xc + BOARD_W / 2, yc - BOARD_H / 2, zf), n, 1, v0);
        const d = faces.vertex(new Vector3(xc + BOARD_W / 2, yc + BOARD_H / 2, zf), n, 1, v1);
        const e = faces.vertex(new Vector3(xc - BOARD_W / 2, yc + BOARD_H / 2, zf), n, 0, v1);
        faces.quad(a, c, d, e);
      }
    }
    const faceMat = new MeshStandardMaterial({ color: PALETTE.graphite800, roughness: 0.18, metalness: 0.3, emissive: '#ffffff', emissiveIntensity: 0 });
    owned.push(faceMat);
    for (const [g, mat, cast] of [
      [steel, lib.graphite, true],
      [trims, lib.titanium, true],
      [faces, faceMat, false],
    ] as const) {
      const mesh = meshOf(g, mat, owned, { cast, receive: true });
      if (mesh) root.add(mesh);
    }
    return { root, owned, faceMat, labels };
  }, [key, deckY]);

  // atlas drawn once the display font is ready (StrictMode-safe: disposed with the effect)
  useEffect(() => {
    let alive = true;
    let tex: CanvasTexture | null = null;
    void ensureFonts().then(() => {
      if (!alive) return;
      tex = drawBoardAtlas(built.labels);
      const m = built.faceMat;
      m.map = tex;
      m.emissiveMap = tex;
      m.emissiveIntensity = 0.7;
      m.color.set('#ffffff');
      m.needsUpdate = true;
    });
    return () => {
      alive = false;
      tex?.dispose();
    };
  }, [built]);

  return <primitive object={built.root} />;
}

/* ------------------------------------------------------------------ */
/* Beacons                                                             */
/* ------------------------------------------------------------------ */

export interface Beacon {
  /** Mast foot (world) — usually deep below the deck. */
  base: V3;
  /** Top height (world y). */
  top: number;
  /** Half section at the foot (m). */
  radius?: number;
}

export function Beacons({ beacons }: { beacons: Beacon[] }) {
  const key = JSON.stringify(beacons);
  const built = useBuilt(() => {
    const lib = getLevelMaterials();
    const owned: Disposable[] = [];
    const root = new Group();
    root.name = 'l1-beacons';
    const mast = new GeoBuilder();
    const dark = new GeoBuilder();
    const glow = new GeoBuilder();
    for (const b of beacons) {
      const r = b.radius ?? 0.55;
      const [x, y0, z] = b.base;
      const h = b.top - y0;
      const m = new Matrix4().makeTranslation(x, 0, z);
      // tapered needle mast
      taperedPrism(mast, chamferRect(r, r, r * 0.3), y0, b.top - 3.2, [1, 1], [0.55, 0.55], { matrix: m });
      // light band + dark collar + finial
      const rt = r * 0.55;
      taperedPrism(dark, chamferRect(rt * 1.25, rt * 1.25, rt * 0.4), b.top - 3.2, b.top - 2.9, [1, 1], [1, 1], { matrix: m, capBottom: true });
      taperedPrism(glow, chamferRect(rt * 1.08, rt * 1.08, rt * 0.35), b.top - 2.9, b.top - 1.1, [1, 1], [1, 1], { matrix: m });
      taperedPrism(dark, chamferRect(rt * 1.25, rt * 1.25, rt * 0.4), b.top - 1.1, b.top - 0.8, [1, 1], [1, 1], { matrix: m, capTop: true });
      taperedPrism(mast, chamferRect(rt * 0.5, rt * 0.5, rt * 0.15), b.top - 0.8, b.top + Math.min(4, h * 0.05), [1, 1], [0.2, 0.2], { matrix: m, capTop: true });
    }
    for (const [b, mat, cast] of [
      [mast, lib.titanium, true],
      [dark, lib.graphite, true],
      [glow, lib.glow.cyan, false],
    ] as const) {
      const mesh = meshOf(b, mat, owned, { cast, receive: cast });
      if (mesh) root.add(mesh);
    }
    return { root, owned };
  }, [key]);
  return <primitive object={built.root} />;
}

/* ------------------------------------------------------------------ */
/* Edge posts                                                          */
/* ------------------------------------------------------------------ */

export interface EdgePost {
  /** Deck surface point at the edge (world) and the deck up vector there. */
  at: Vector3;
  up: Vector3;
}

export function EdgePosts({ posts, height = 1.5 }: { posts: EdgePost[]; height?: number }) {
  const key = JSON.stringify(posts.map((p) => [p.at.toArray(), p.up.toArray()]));
  const built = useBuilt(() => {
    const lib = getLevelMaterials();
    const owned: Disposable[] = [];
    const root = new Group();
    root.name = 'l1-edge-posts';
    const body = new GeoBuilder();
    const glow = new GeoBuilder();
    for (const p of posts) {
      // upright posts (world up), standing on a small bracket at the deck edge
      const m = new Matrix4().makeTranslation(p.at.x, p.at.y, p.at.z);
      taperedPrism(body, chamferRect(0.16, 0.16, 0.05), -0.9, height - 0.35, [1.2, 1.2], [1, 1], { matrix: m });
      taperedPrism(glow, chamferRect(0.15, 0.15, 0.05), height - 0.35, height, [1, 1], [1, 1], { matrix: m, capTop: true });
    }
    for (const [b, mat, cast] of [
      [body, lib.graphite, true],
      [glow, lib.glow.cyan, false],
    ] as const) {
      const mesh = meshOf(b, mat, owned, { cast, receive: cast });
      if (mesh) root.add(mesh);
    }
    return { root, owned };
  }, [key, height]);
  return <primitive object={built.root} />;
}

/* ------------------------------------------------------------------ */
/* Target gate                                                         */
/* ------------------------------------------------------------------ */

/**
 * A slim graphite bar with a cyan underside line and a TARGET panel, spanning between two beacon
 * masts high above the start of the rings: from the lip it frames where to fly (land between this
 * gate and the FINISH arch). Far above every trajectory.
 */
export function TargetGate({ center, span, label = 'TARGET' }: { center: V3; span: number; label?: string }) {
  const key = JSON.stringify([center, span]);
  const built = useBuilt(() => {
    const lib = getLevelMaterials();
    const owned: Disposable[] = [];
    const root = new Group();
    root.name = 'l1-target-gate';
    const [x, y, z] = center;
    const bar = new GeoBuilder();
    const glow = new GeoBuilder();
    taperedPrism(bar, chamferRect(span / 2, 0.9, 0.3), y - 0.8, y + 0.8, [1, 1], [1, 1], { matrix: new Matrix4().makeTranslation(x, 0, z), capTop: true, capBottom: true });
    taperedPrism(glow, chamferRect(span / 2 - 0.4, 0.14, 0), y - 0.92, y - 0.8, [1, 1], [1, 1], { matrix: new Matrix4().makeTranslation(x, 0, z + 0.55), capTop: true, capBottom: true });
    for (const [b, mat, cast] of [
      [bar, lib.graphite, true],
      [glow, lib.glow.cyan, false],
    ] as const) {
      const mesh = meshOf(b, mat, owned, { cast, receive: cast });
      if (mesh) root.add(mesh);
    }
    return { root, owned };
  }, [key]);
  return (
    <group>
      <primitive object={built.root} />
      <Billboard position={[center[0], center[1] - 0.75, center[2] + 0.95]} text={label} width={14} height={2.6} postHeight={0} emissive={0.75} />
    </group>
  );
}
