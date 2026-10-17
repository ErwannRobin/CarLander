import RAPIER from '@dimforge/rapier3d-compat';
import { Box3, Vector3 } from 'three';
import { buildRibbon } from '../track/Ribbon';
import { quatFromRotationDeg } from '../track/zones';
import { TUNING } from '../tuning';
import type { LevelDef, SurfaceKind, TrackFrame, TrackStyle } from '../types';
import { assertPhysicsReady } from './initPhysics';

/* ------------------------------------------------------------------ */
/* Collision groups                                                    */
/* ------------------------------------------------------------------ */

/**
 * Collision group bits (Rapier InteractionGroups = 16-bit membership << 16 | 16-bit filter).
 * - STATIC: every level collider. ADHESIVE: additionally set on vacuum-compatible colliders.
 * - CAR: the chassis colliders (collide with STATIC only).
 * - QUERY: membership used by the car's own rays and the trajectory predictor, so queries can
 *   never hit the car itself.
 */
export const GROUP = {
  STATIC: 0x0001,
  ADHESIVE: 0x0002,
  CAR: 0x0004,
  QUERY: 0x0008,
} as const;

export function interactionGroups(membership: number, filter: number): number {
  return (((membership & 0xffff) << 16) | (filter & 0xffff)) >>> 0;
}

export function staticGroups(adhesive: boolean): number {
  return interactionGroups(GROUP.STATIC | (adhesive ? GROUP.ADHESIVE : 0), GROUP.CAR | GROUP.QUERY);
}
export const CAR_GROUPS = interactionGroups(GROUP.CAR, GROUP.STATIC);
/** Queries against every static collider. */
export const QUERY_STATIC = interactionGroups(GROUP.QUERY, GROUP.STATIC);
/** Queries against adhesive (vacuum-compatible) static colliders only. */
export const QUERY_ADHESIVE = interactionGroups(GROUP.QUERY, GROUP.ADHESIVE);

const QUERY_FLAGS = RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;

/* ------------------------------------------------------------------ */
/* Surfaces & hits                                                     */
/* ------------------------------------------------------------------ */

export interface SurfaceInfo {
  kind: SurfaceKind;
  adhesive: boolean;
  pieceId: string;
  style: TrackStyle;
}

export interface RayHit {
  /** World hit point. */
  point: Vector3;
  /** Outward surface normal (smoothed along ribbon drive surfaces). */
  normal: Vector3;
  /** Distance from the ray origin (m). */
  distance: number;
  surface: SurfaceInfo;
  colliderHandle: number;
}

export function createRayHit(): RayHit {
  return {
    point: new Vector3(),
    normal: new Vector3(0, 1, 0),
    distance: 0,
    surface: UNKNOWN_SURFACE,
    colliderHandle: -1,
  };
}

export interface RaycastOptions {
  /** Only hit vacuum-compatible colliders. */
  adhesiveOnly?: boolean;
  /**
   * Warm-start slot (0..SMOOTH_SLOTS-1) for the ribbon normal smoothing search. Use a stable slot
   * per ray channel (e.g. per wheel) so the nearest-segment lookup stays O(1).
   */
  slot?: number;
}

const UNKNOWN_SURFACE: SurfaceInfo = Object.freeze({
  kind: 'concrete',
  adhesive: false,
  pieceId: '',
  style: 'platform',
}) as SurfaceInfo;

const STYLE_KIND: Record<TrackStyle, SurfaceKind> = {
  runway: 'asphalt',
  ramp: 'asphalt',
  landing: 'landing',
  adhesive: 'adhesive',
  platform: 'concrete',
  metal: 'metal',
  glass: 'metal',
};

export function surfaceKindForStyle(style: TrackStyle): SurfaceKind {
  return STYLE_KIND[style] ?? 'concrete';
}

/* ------------------------------------------------------------------ */
/* Ribbon normal smoothing                                             */
/* ------------------------------------------------------------------ */

const SMOOTH_SLOTS = 32;
const _seg = new Vector3();
const _rel = new Vector3();
const _lerp = new Vector3();

/**
 * Ribbon colliders are faceted (one quad per frame step), so raw face normals step by a few
 * degrees on curves (≈2.2° per meter on a 26 m radius). Suspension damping and force directions
 * would then "buzz" at facet boundaries at speed. For hits on the drive surface we replace the
 * face normal with the frame `up` interpolated at the hit's arc position.
 */
class RibbonLookup {
  private readonly halfWidths: number[];
  constructor(
    readonly frames: TrackFrame[],
    width: number | ((s: number) => number),
  ) {
    this.halfWidths = frames.map((f) => (typeof width === 'function' ? width(f.s) : width) / 2);
  }

  /** Projection parameter of `p` on segment i (0..1 inside). */
  private param(i: number, p: Vector3): number {
    const a = this.frames[i].position;
    const b = this.frames[i + 1].position;
    _seg.subVectors(b, a);
    const len2 = Math.max(1e-9, _seg.lengthSq());
    return _rel.subVectors(p, a).dot(_seg) / len2;
  }

  /** True when `p` lies on the drive surface strip of segment i at parameter t. */
  private onStrip(i: number, t: number, p: Vector3): boolean {
    const a = this.frames[i];
    const b = this.frames[i + 1];
    _lerp.copy(a.position).lerp(b.position, t);
    const hw = Math.max(this.halfWidths[i], this.halfWidths[i + 1]);
    // lateral distance within the half width (+ margin for rails), vertical close to the surface
    _rel.subVectors(p, _lerp);
    const up = a.up;
    const vertical = Math.abs(_rel.dot(up));
    const lateral = Math.abs(_rel.dot(a.right));
    return vertical < 1.5 && lateral < hw + 1.0;
  }

  /** Finds the segment containing p, starting from `hint`. Returns -1 when not on this ribbon. */
  findSegment(p: Vector3, hint: number): number {
    const n = this.frames.length - 1;
    if (n < 1) return -1;
    let i = Math.min(Math.max(0, hint), n - 1);
    // local walk (coherent queries take 0–2 steps)
    for (let iter = 0; iter < 8; iter++) {
      const t = this.param(i, p);
      if (t < 0 && i > 0) i--;
      else if (t > 1 && i < n - 1) i++;
      else break;
    }
    const t = this.param(i, p);
    if (t >= -0.05 && t <= 1.05 && this.onStrip(i, Math.min(1, Math.max(0, t)), p)) return i;
    // global fallback (piece switch / self-overlapping shapes such as the crescent)
    for (let k = 0; k < n; k++) {
      const tk = this.param(k, p);
      if (tk >= -0.02 && tk <= 1.02 && this.onStrip(k, Math.min(1, Math.max(0, tk)), p)) return k;
    }
    return -1;
  }

  /** Writes the smoothed surface up at p (segment i) into out. */
  smoothUp(i: number, p: Vector3, out: Vector3): Vector3 {
    const t = Math.min(1, Math.max(0, this.param(i, p)));
    return out.copy(this.frames[i].up).lerp(this.frames[i + 1].up, t).normalize();
  }
}

/* ------------------------------------------------------------------ */
/* PhysicsWorld                                                        */
/* ------------------------------------------------------------------ */

const _origin = new Vector3();

/**
 * Rapier world built from a LevelDef: static level colliders (ribbon trimeshes, cuboids) with a
 * collider-handle → SurfaceInfo map, plus query helpers that never hit the car.
 *
 * The world is fully deterministic for a given LevelDef: colliders are created in piece order.
 */
export class PhysicsWorld {
  readonly world: RAPIER.World;
  readonly eventQueue: RAPIER.EventQueue;
  readonly level: LevelDef;
  /** World-space bounds of all static geometry. */
  readonly bounds = new Box3();
  readonly gravity: number;

  private readonly surfaces = new Map<number, SurfaceInfo>();
  private readonly ribbons = new Map<number, RibbonLookup>();
  private readonly slotHints = new Int32Array(SMOOTH_SLOTS);
  private readonly ray: RAPIER.Ray;
  private disposed = false;

  constructor(level: LevelDef, gravity: number = TUNING.gravity) {
    assertPhysicsReady('PhysicsWorld');
    this.level = level;
    this.gravity = gravity;
    this.world = new RAPIER.World({ x: 0, y: -gravity, z: 0 });
    this.world.timestep = TUNING.dt;
    this.eventQueue = new RAPIER.EventQueue(true);
    this.ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.buildStatic(level);
    // Static colliders only become visible to scene queries once the broad phase has been
    // updated; stepping an empty (static-only) world is side-effect free.
    this.world.step(this.eventQueue);
  }

  private buildStatic(level: LevelDef): void {
    const v = new Vector3();
    for (const piece of level.pieces) {
      if (piece.kind === 'ribbon') {
        if (piece.frames.length < 2) continue;
        const geo = buildRibbon(piece.frames, {
          width: piece.width,
          thickness: piece.thickness ?? 1.2,
          rails: piece.rails ?? 0,
        });
        const adhesive = piece.adhesive ?? true;
        const desc = RAPIER.ColliderDesc.trimesh(
          geo.collider.vertices,
          geo.collider.indices,
          RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES,
        )
          .setFriction(0.7)
          .setRestitution(0)
          .setCollisionGroups(staticGroups(adhesive))
          .setSolverGroups(staticGroups(adhesive));
        const collider = this.world.createCollider(desc);
        this.surfaces.set(collider.handle, {
          kind: surfaceKindForStyle(piece.style),
          adhesive,
          pieceId: piece.id,
          style: piece.style,
        });
        this.ribbons.set(collider.handle, new RibbonLookup(piece.frames, piece.width));
        const verts = geo.collider.vertices;
        for (let i = 0; i < verts.length; i += 3) this.bounds.expandByPoint(v.set(verts[i], verts[i + 1], verts[i + 2]));
      } else {
        if (piece.collidable === false) continue;
        const adhesive = piece.adhesive ?? false;
        const q = quatFromRotationDeg(piece.rotationDeg);
        const [hx, hy, hz] = [piece.size[0] / 2, piece.size[1] / 2, piece.size[2] / 2];
        const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
          .setTranslation(piece.center[0], piece.center[1], piece.center[2])
          .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
          .setFriction(0.7)
          .setRestitution(0)
          .setCollisionGroups(staticGroups(adhesive))
          .setSolverGroups(staticGroups(adhesive));
        const collider = this.world.createCollider(desc);
        this.surfaces.set(collider.handle, {
          kind: surfaceKindForStyle(piece.style),
          adhesive,
          pieceId: piece.id,
          style: piece.style,
        });
        for (let sx = -1; sx <= 1; sx += 2)
          for (let sy = -1; sy <= 1; sy += 2)
            for (let sz = -1; sz <= 1; sz += 2) {
              v.set(sx * hx, sy * hy, sz * hz).applyQuaternion(q);
              v.x += piece.center[0];
              v.y += piece.center[1];
              v.z += piece.center[2];
              this.bounds.expandByPoint(v);
            }
      }
    }
    if (this.bounds.isEmpty()) this.bounds.set(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
  }

  /** Surface info for a static collider handle (undefined for the car / unknown). */
  surfaceOf(handle: number): SurfaceInfo | undefined {
    return this.surfaces.get(handle);
  }

  /** Advances the world by one fixed tick (TUNING.dt), collecting events in `eventQueue`. */
  step(): void {
    this.world.step(this.eventQueue);
  }

  /**
   * Casts a ray against static level geometry (the car is always excluded).
   * `dir` must be normalized. Writes into `out` (allocated if omitted) and returns it, or null.
   */
  raycast(origin: Vector3, dir: Vector3, maxDist: number, out?: RayHit, opts?: RaycastOptions): RayHit | null {
    const r = this.ray;
    r.origin.x = origin.x;
    r.origin.y = origin.y;
    r.origin.z = origin.z;
    r.dir.x = dir.x;
    r.dir.y = dir.y;
    r.dir.z = dir.z;
    const groups = opts?.adhesiveOnly ? QUERY_ADHESIVE : QUERY_STATIC;
    const hit = this.world.castRayAndGetNormal(r, maxDist, true, QUERY_FLAGS, groups);
    if (!hit) return null;
    const res = out ?? createRayHit();
    const toi = hit.timeOfImpact;
    res.distance = toi;
    res.point.copy(origin).addScaledVector(dir, toi);
    const handle = hit.collider.handle;
    res.colliderHandle = handle;
    res.surface = this.surfaces.get(handle) ?? UNKNOWN_SURFACE;
    const n = hit.normal;
    const len = Math.hypot(n.x, n.y, n.z);
    if (len > 1e-6 && toi > 0) res.normal.set(n.x / len, n.y / len, n.z / len);
    else res.normal.copy(dir).negate(); // origin inside a solid: push back along the ray
    this.smoothNormal(res, opts?.slot ?? -1);
    return res;
  }

  /** Replaces a ribbon drive-surface face normal by the interpolated frame up. */
  private smoothNormal(hit: RayHit, slot: number): void {
    const lookup = this.ribbons.get(hit.colliderHandle);
    if (!lookup) return;
    const hint = slot >= 0 && slot < SMOOTH_SLOTS ? this.slotHints[slot] : 0;
    const seg = lookup.findSegment(hit.point, hint);
    if (seg < 0) return;
    if (slot >= 0 && slot < SMOOTH_SLOTS) this.slotHints[slot] = seg;
    const up = lookup.smoothUp(seg, hit.point, _origin);
    // only the drive surface (top faces, incl. rail tops) is smoothed; sides/bottom keep face normals
    if (up.dot(hit.normal) > 0.85) hit.normal.copy(up);
  }

  /** Convenience: distance to the nearest static surface straight below `p` (world -Y). */
  heightAbove(p: Vector3, maxDist = 500, out?: RayHit): number {
    const hit = this.raycast(p, DOWN, maxDist, out);
    return hit ? hit.distance : Infinity;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.surfaces.clear();
    this.ribbons.clear();
    this.eventQueue.free();
    this.world.free();
  }
}

const DOWN = new Vector3(0, -1, 0);
