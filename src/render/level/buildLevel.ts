/**
 * Imperative level geometry build: track pieces merged per material, auto supports and zone
 * markers. Pure three.js (no React) so it can be used outside R3F; <LevelGeometry> wraps it.
 */
import { Group, Mesh, type Material } from 'three';
import type { LevelDef, ThemeId } from '@/game/types';
import { runtime } from '@/game/runtime';
import { getFieldTopMaterial, getLevelMaterials, type LevelMaterials } from './materials';
import { PartBin } from './geometry/GeoBuilder';
import {
  addBoxPiece,
  addRibbonPiece,
  DEFAULT_EDGE_STYLE,
  type BoxInfo,
  type EdgeStyle,
  type RibbonInfo,
  type TrackPartKey,
} from './geometry/trackGeometry';
import { buildSupports, type SupportOptions } from './geometry/supports';
import { buildZoneMarkers } from './geometry/zoneMarkers';
import { SurfaceProbe } from './geometry/surfaceProbe';

export interface LevelBuildOptions {
  /** Cast / receive shadows on deck geometry. Default: runtime.quality.shadows. */
  shadows?: boolean;
  /** Auto-generated supports (pylons / truss backing). */
  supports?: SupportOptions;
  /** Render zone markers (target rings, finish arch, gates). Default true. */
  zoneMarkers?: boolean;
  /**
   * Strength of the additive light wash next to edge LEDs (0 = off). Default from the level theme:
   * night 1 (hero effect), canyon 0.3, morning / title 0.22 (daylight swamps it).
   */
  ledSpill?: number;
}

/** Default edge-LED spill strength per theme (the LED wash only reads in the dark). */
const THEME_SPILL: Record<ThemeId, number> = { night: 1, canyon: 0.3, morning: 0.22, title: 0.22 };

export interface LevelBuild {
  group: Group;
  ribbons: RibbonInfo[];
  boxes: BoxInfo[];
  probe: SurfaceProbe;
  /** Releases every geometry (and per-level texture) created by the build. Shared materials stay cached. */
  dispose(): void;
}

function materialFor(key: TrackPartKey, lib: LevelMaterials): Material {
  if (key.startsWith('top:')) return lib.top[key.slice(4) as keyof LevelMaterials['top']];
  if (key.startsWith('field:')) return getFieldTopMaterial(key.slice(6) as keyof LevelMaterials['top']);
  if (key.startsWith('led:')) return lib.led[key.slice(4) as keyof LevelMaterials['led']];
  if (key.startsWith('spill:')) return lib.spill[key.slice(6) as keyof LevelMaterials['spill']];
  switch (key) {
    case 'side:concrete':
      return lib.sideConcrete;
    case 'side:metal':
      return lib.sideMetal;
    case 'rail':
      return lib.rail;
    case 'trim':
      return lib.trim;
  }
  throw new Error(`unknown part key ${key}`);
}

export function buildLevelGeometry(level: LevelDef, opts: LevelBuildOptions = {}): LevelBuild {
  const lib = getLevelMaterials();
  const shadows = opts.shadows ?? runtime.quality.shadows;
  const edge: EdgeStyle = {
    ...DEFAULT_EDGE_STYLE,
    spillStrength: Math.max(0, opts.ledSpill ?? THEME_SPILL[level.theme] ?? 1),
  };
  const bin = new PartBin<TrackPartKey>();
  const ribbons: RibbonInfo[] = [];
  const boxes: BoxInfo[] = [];
  for (const piece of level.pieces) {
    if (piece.kind === 'ribbon') {
      if (piece.frames.length < 2) {
        console.warn(`[LevelGeometry] ribbon "${piece.id}" has fewer than 2 frames — skipped`);
        continue;
      }
      ribbons.push(addRibbonPiece(bin, piece, edge));
    } else boxes.push(addBoxPiece(bin, piece, edge));
  }

  const group = new Group();
  group.name = 'level-geometry';
  const disposables: { dispose(): void }[] = [];

  const track = new Group();
  track.name = 'track';
  for (const [key, geo] of bin.merge()) {
    const mesh = new Mesh(geo, materialFor(key, lib));
    mesh.name = key;
    const isLight = key.startsWith('led:') || key.startsWith('spill:');
    const isTrim = key === 'trim';
    mesh.castShadow = shadows && !isLight && !isTrim;
    mesh.receiveShadow = shadows && !isLight;
    if (key.startsWith('spill:')) mesh.renderOrder = 1; // additive glow after opaque decks
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    track.add(mesh);
    disposables.push(geo);
  }
  group.add(track);

  const probe = new SurfaceProbe(ribbons, boxes);

  const supports = buildSupports(level, ribbons, boxes, probe, opts.supports);
  group.add(supports.group);
  disposables.push(supports);

  if (opts.zoneMarkers ?? true) {
    const markers = buildZoneMarkers(level, probe);
    group.add(markers.group);
    disposables.push(markers);
  }

  return {
    group,
    ribbons,
    boxes,
    probe,
    dispose() {
      // Releases GPU resources only. The scene graph is left intact on purpose: three re-uploads
      // disposed resources if they are rendered again (React StrictMode re-mounts memoized builds).
      for (const d of disposables) d.dispose();
    },
  };
}
