/**
 * Lattice / truss generation. Members are accumulated in a MemberBatch and emitted as ONE
 * InstancedMesh of a unit tube (8 sides, open-ended, spanning y = 0..1), so an entire tower with
 * hundreds of members costs a single draw call.
 */
import {
  CylinderGeometry,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';

const Y = new Vector3(0, 1, 0);
const _dir = new Vector3();
const _q = new Quaternion();
const _s = new Vector3();
const _m = new Matrix4();

let unitTube: BufferGeometry | null = null;
/** Shared unit tube geometry (radius 1, height 1, base at y = 0). Never dispose it per instance. */
export function getUnitTube(): BufferGeometry {
  if (!unitTube) {
    unitTube = new CylinderGeometry(1, 1, 1, 8, 1, true);
    unitTube.translate(0, 0.5, 0);
    // module attribute convention
    unitTube.setAttribute('uv1', unitTube.getAttribute('uv').clone());
  }
  return unitTube;
}

export class MemberBatch {
  private matrices: number[] = [];

  get count(): number {
    return this.matrices.length / 16;
  }

  /** Adds a tube member between a and b. */
  add(a: Vector3, b: Vector3, radius: number): void {
    _dir.subVectors(b, a);
    const len = _dir.length();
    if (len < 1e-4) return;
    _dir.divideScalar(len);
    _q.setFromUnitVectors(Y, _dir);
    _s.set(radius, len, radius);
    _m.compose(a, _q, _s);
    for (let i = 0; i < 16; i++) this.matrices.push(_m.elements[i]);
  }

  /** Adds a polyline as consecutive members. */
  addPolyline(points: Vector3[], radius: number): void {
    for (let i = 0; i < points.length - 1; i++) this.add(points[i], points[i + 1], radius);
  }

  /** Builds the InstancedMesh (shared unit geometry; dispose the mesh, not the geometry). */
  build(material: Material, castShadow = true): InstancedMesh | null {
    const n = this.count;
    if (n === 0) return null;
    const mesh = new InstancedMesh(getUnitTube(), material, n);
    mesh.instanceMatrix.array.set(this.matrices);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.computeBoundingBox();
    mesh.castShadow = castShadow;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }
}

export type BracePattern = 'x' | 'zigzag';

export interface TowerSpec {
  /** Base center (world or local). */
  base: Vector3;
  height: number;
  /** Footprint along the local X axis / Z axis. */
  width: number;
  depth: number;
  /** Rotation about Y (rad). */
  yaw?: number;
  /** Bay (panel) height (m). */
  bay?: number;
  legRadius?: number;
  braceRadius?: number;
  pattern?: BracePattern;
  /** Taper: top footprint scale (1 = straight). */
  taper?: number;
}

/**
 * Four-legged lattice tower: legs, horizontal girts each bay, diagonals on every face.
 * Returns the node rings (4 corners per level, bottom to top) for attaching ties.
 */
export function latticeTower(batch: MemberBatch, spec: TowerSpec): Vector3[][] {
  const bay = spec.bay ?? Math.max(2, Math.min(spec.width, spec.depth) * 0.75);
  const levels = Math.max(1, Math.round(spec.height / bay));
  const rl = spec.legRadius ?? Math.max(0.08, Math.min(spec.width, spec.depth) * 0.025);
  const rb = spec.braceRadius ?? rl * 0.55;
  const yaw = spec.yaw ?? 0;
  const taper = spec.taper ?? 1;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const rings: Vector3[][] = [];
  for (let l = 0; l <= levels; l++) {
    const t = l / levels;
    const k = 1 + (taper - 1) * t;
    const hx = (spec.width / 2) * k;
    const hz = (spec.depth / 2) * k;
    const y = spec.base.y + spec.height * t;
    const ring = [
      [-hx, -hz],
      [hx, -hz],
      [hx, hz],
      [-hx, hz],
    ].map(([x, z]) => new Vector3(spec.base.x + x * cos + z * sin, y, spec.base.z - x * sin + z * cos));
    rings.push(ring);
  }
  for (let l = 0; l <= levels; l++) {
    const ring = rings[l];
    for (let c = 0; c < 4; c++) {
      batch.add(ring[c], ring[(c + 1) % 4], rb);
      if (l < levels) {
        const up = rings[l + 1];
        batch.add(ring[c], up[c], rl);
        const pattern = spec.pattern ?? 'x';
        if (pattern === 'x') {
          batch.add(ring[c], up[(c + 1) % 4], rb);
          batch.add(ring[(c + 1) % 4], up[c], rb);
        } else if ((l + c) % 2 === 0) batch.add(ring[c], up[(c + 1) % 4], rb);
        else batch.add(ring[(c + 1) % 4], up[c], rb);
      }
    }
    // plan bracing every few levels keeps the tower from reading as a hollow box
    if (l % 3 === 0) batch.add(ring[0], ring[2], rb * 0.9);
  }
  return rings;
}

export interface SweptTrussSpec {
  /** Centerline points of the truss (world). */
  points: Vector3[];
  /** Per point lateral axis and "depth" axis (the truss extends from the points along -depthAxis... see below). */
  rights: Vector3[];
  /** Per point axis the truss extends AWAY along (chords at 0 and -depth along this axis). */
  ups: Vector3[];
  halfWidth: number;
  depth: number;
  chordRadius: number;
  braceRadius: number;
  /** Draw diagonals on the two lateral faces only (lighter look). */
  sidesOnly?: boolean;
}

/**
 * Box truss swept along a polyline: 4 chords (inner pair at the points, outer pair offset by
 * -up * depth), cross frames at every point and alternating diagonals on each face.
 * Returns the outer chord node lists (left, right) for attaching ties.
 */
export function sweptBoxTruss(batch: MemberBatch, spec: SweptTrussSpec): { innerL: Vector3[]; innerR: Vector3[]; outerL: Vector3[]; outerR: Vector3[] } {
  const n = spec.points.length;
  const innerL: Vector3[] = [];
  const innerR: Vector3[] = [];
  const outerL: Vector3[] = [];
  const outerR: Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const p = spec.points[i];
    const r = spec.rights[i];
    const u = spec.ups[i];
    const l = p.clone().addScaledVector(r, -spec.halfWidth);
    const rr = p.clone().addScaledVector(r, spec.halfWidth);
    innerL.push(l);
    innerR.push(rr);
    outerL.push(l.clone().addScaledVector(u, -spec.depth));
    outerR.push(rr.clone().addScaledVector(u, -spec.depth));
  }
  const rc = spec.chordRadius;
  const rb = spec.braceRadius;
  for (const chord of [innerL, innerR, outerL, outerR]) batch.addPolyline(chord, rc);
  for (let i = 0; i < n; i++) {
    batch.add(innerL[i], innerR[i], rb);
    batch.add(outerL[i], outerR[i], rb);
    batch.add(innerL[i], outerL[i], rb);
    batch.add(innerR[i], outerR[i], rb);
    if (i === n - 1) break;
    const flip = i % 2 === 0;
    // lateral faces (L and R)
    batch.add(flip ? innerL[i] : outerL[i], flip ? outerL[i + 1] : innerL[i + 1], rb);
    batch.add(flip ? innerR[i] : outerR[i], flip ? outerR[i + 1] : innerR[i + 1], rb);
    if (!spec.sidesOnly) {
      // outer face and inner face
      batch.add(flip ? outerL[i] : outerR[i], flip ? outerR[i + 1] : outerL[i + 1], rb);
      batch.add(flip ? innerR[i] : innerL[i], flip ? innerL[i + 1] : innerR[i + 1], rb);
    }
  }
  return { innerL, innerR, outerL, outerR };
}

export interface BeamSpec {
  from: Vector3;
  to: Vector3;
  /** Up hint for the beam cross-section. Default world up. */
  up?: Vector3;
  width: number;
  height: number;
  /** Panel length (m). Default ~ height. */
  bay?: number;
  chordRadius?: number;
  braceRadius?: number;
}

/** Straight box truss beam between two points (chords centered on the from->to line). */
export function latticeBeam(batch: MemberBatch, spec: BeamSpec): void {
  const dir = new Vector3().subVectors(spec.to, spec.from);
  const len = dir.length();
  if (len < 1e-3) return;
  dir.divideScalar(len);
  const hint = spec.up ?? Y;
  let right = new Vector3().crossVectors(dir, hint);
  if (right.lengthSq() < 1e-6) right = new Vector3().crossVectors(dir, new Vector3(1, 0, 0));
  right.normalize();
  const up = new Vector3().crossVectors(right, dir).normalize();
  const bay = spec.bay ?? Math.max(1, spec.height);
  const n = Math.max(1, Math.round(len / bay));
  const points: Vector3[] = [];
  const rights: Vector3[] = [];
  const ups: Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    points.push(spec.from.clone().addScaledVector(dir, (len * i) / n).addScaledVector(up, spec.height / 2));
    rights.push(right);
    ups.push(up);
  }
  const rc = spec.chordRadius ?? Math.max(0.05, Math.min(spec.width, spec.height) * 0.05);
  sweptBoxTruss(batch, {
    points,
    rights,
    ups,
    halfWidth: spec.width / 2,
    depth: spec.height,
    chordRadius: rc,
    braceRadius: spec.braceRadius ?? rc * 0.6,
  });
}
