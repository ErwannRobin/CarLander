/**
 * Shared, ref-counted car geometry.
 *
 * All static body parts are generated once and merged per material slot (one draw call each).
 * Instances call acquireCarGeometry() on mount and releaseCarGeometry() on unmount; when the last
 * instance goes away the GPU buffers are disposed after a short grace period (so React StrictMode
 * double-mounts and scene transitions between the showroom and the game do not rebuild).
 */
import type { BufferGeometry } from 'three';
import { VEHICLE } from '@/game/vehicleSpec';
import { buildCanopy, buildLowerBody, buildPaintShell, paintShellTailRing } from './geometry/bodyParts';
import { clearCurveCache } from './geometry/bodySurface';
import { buildAero, buildIntakeVane, buildLights, buildMirrors, buildNozzleBezels, buildNozzles, buildRcsPorts, buildSillBlades, buildSkirt, buildTail } from './geometry/details';
import { mergeParts } from './geometry/loft';
import { buildWheelSet, clearWheelCache, type WheelGeometrySet } from './geometry/wheelParts';

export interface CarGeometry {
  /** Pearl paint: lofted shell, Kamm-tail frame, mirror pods. */
  paint: BufferGeometry;
  /** Satin black: lower body / arch liners / floor, tail fascia, canopy frame, aero, stalks, nozzle housings, skirt plate, RCS vents. */
  trim: BufferGeometry;
  /** Dark glass: canopy, light housings, mirror glass. */
  glass: BufferGeometry;
  /** Vertex-coloured titanium: heat-tinted nozzle bells, RCS rims. */
  titanium: BufferGeometry;
  lightFront: BufferGeometry;
  lightRear: BufferGeometry;
  /** Additive throat glow inside the nozzles. */
  throat: BufferGeometry;
  /** Cyan vacuum skirt grille. */
  vacuum: BufferGeometry;
  wheelFront: WheelGeometrySet;
  wheelRear: WheelGeometrySet;
  stats: { triangles: number; buildMs: number };
}

let cache: CarGeometry | null = null;
let refs = 0;
let disposeTimer: ReturnType<typeof setTimeout> | null = null;
const DISPOSE_GRACE_MS = 1500;

function triCount(g: BufferGeometry): number {
  return (g.index ? g.index.count : g.getAttribute('position').count) / 3;
}

function build(): CarGeometry {
  const t0 = performance.now();
  const paintShell = buildPaintShell();
  const lower = buildLowerBody();
  const canopy = buildCanopy();
  // the Kamm face shares the shell's last ring (positions + normals) for a seamless tail edge
  const tail = buildTail(lower.tailRing, paintShellTailRing(paintShell));
  const lights = buildLights();
  const nozzles = buildNozzles();
  const rcs = buildRcsPorts();
  const skirt = buildSkirt();
  const aero = buildAero();
  const mirrors = buildMirrors();
  const bezels = buildNozzleBezels();
  const blades = buildSillBlades();
  const vane = buildIntakeVane();

  const geo: Omit<CarGeometry, 'stats'> = {
    paint: mergeParts([paintShell, tail.paint, mirrors.pods]),
    trim: mergeParts([lower.geometry, tail.black, canopy.frame, aero, mirrors.stalks, nozzles.housings, skirt.plate, rcs.vents]),
    glass: mergeParts([canopy.glass, lights.housings, mirrors.glass, tail.gloss]),
    titanium: mergeParts([nozzles.bells, rcs.rims, bezels, blades, vane], true),
    lightFront: mergeParts([lights.frontLight]),
    lightRear: mergeParts([lights.rearLight]),
    throat: mergeParts([nozzles.throat], true),
    vacuum: mergeParts([skirt.grille]),
    wheelFront: buildWheelSet(VEHICLE.wheelWidthFront),
    wheelRear: buildWheelSet(VEHICLE.wheelWidthRear),
  };
  clearCurveCache();
  let triangles = 0;
  for (const g of [geo.paint, geo.trim, geo.glass, geo.titanium, geo.lightFront, geo.lightRear, geo.throat, geo.vacuum]) {
    triangles += triCount(g);
  }
  for (const w of [geo.wheelFront, geo.wheelFront, geo.wheelRear, geo.wheelRear]) {
    triangles += triCount(w.tire) + triCount(w.rim) + triCount(w.blur) + triCount(w.caliper);
  }
  return { ...geo, stats: { triangles: Math.round(triangles), buildMs: performance.now() - t0 } };
}

function disposeAll(g: CarGeometry): void {
  for (const b of [g.paint, g.trim, g.glass, g.titanium, g.lightFront, g.lightRear, g.throat, g.vacuum]) b.dispose();
  for (const w of [g.wheelFront, g.wheelRear]) {
    w.tire.dispose();
    w.rim.dispose();
    w.blur.dispose();
    w.caliper.dispose();
  }
  clearWheelCache();
}

/** Dispose the cache after the grace period unless someone acquires it in the meantime. */
function scheduleDispose(): void {
  if (refs > 0 || disposeTimer !== null) return;
  disposeTimer = setTimeout(() => {
    disposeTimer = null;
    if (refs === 0 && cache) {
      disposeAll(cache);
      cache = null;
    }
  }, DISPOSE_GRACE_MS);
}

/** Get (building on first use) the shared car geometry and take a reference. */
export function acquireCarGeometry(): CarGeometry {
  if (disposeTimer !== null) {
    clearTimeout(disposeTimer);
    disposeTimer = null;
  }
  if (!cache) cache = build();
  refs++;
  return cache;
}

/**
 * Peek at the geometry without taking a reference (builds if needed). Used during render, before
 * the mount effect acquires it. A build nobody acquires (a render React discards) is freed after
 * the usual grace period.
 */
export function peekCarGeometry(): CarGeometry {
  if (!cache) {
    cache = build();
    scheduleDispose();
  }
  return cache;
}

/** Drop a reference; the last release disposes GPU buffers after a grace period. */
export function releaseCarGeometry(): void {
  refs = Math.max(0, refs - 1);
  scheduleDispose();
}

/** Debug / sandbox: cache state without building or taking a reference. */
export function carGeometryStatus(): { built: boolean; refs: number; stats: CarGeometry['stats'] | null } {
  return { built: cache !== null, refs, stats: cache ? cache.stats : null };
}
