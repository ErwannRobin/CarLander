/**
 * Analytic drive-surface queries against the level's ribbons and boxes (no raycasting):
 *  - probe(p): nearest drive surface "under" p, measured along that surface's own up axis
 *    (works on slopes and inverted sections) — used to seat zone markers on the deck.
 *  - verticalHits(x, z, yTop, yBottom): world-vertical line test — used to keep pylons clear
 *    of decks below and to stand towers on floors.
 */
import { Matrix4, Vector3 } from 'three';
import type { BoxInfo, RibbonInfo } from './trackGeometry';

export interface SurfaceHit {
  point: Vector3;
  normal: Vector3;
  /** Surface forward / right at the hit (track frame axes or box axes). */
  forward: Vector3;
  right: Vector3;
  /** Distance from the query point to the surface along the normal. */
  distance: number;
  ribbon: RibbonInfo | null;
  box: BoxInfo | null;
  /** Arc length on the ribbon (ribbons only). */
  s: number;
  /** Lateral offset from the ribbon centerline (m), and half width there. */
  lateral: number;
  halfWidth: number;
}

const _d = new Vector3();
const _p = new Vector3();
const _up = new Vector3();
const _fw = new Vector3();
const _rt = new Vector3();

export class SurfaceProbe {
  private boxInv: Matrix4[];
  constructor(
    readonly ribbons: RibbonInfo[],
    readonly boxes: BoxInfo[],
  ) {
    this.boxInv = boxes.map((b) => b.matrix.clone().invert());
  }

  /**
   * Nearest surface on whose driving side `p` lies, within `maxDistance` along the normal.
   * `lateralMargin` extends ribbon/box bounds sideways (m).
   */
  probe(p: Vector3, maxDistance = 50, lateralMargin = 0, exclude?: RibbonInfo): SurfaceHit | null {
    let best: SurfaceHit | null = null;
    const tol = 0.25;
    for (const rb of this.ribbons) {
      if (rb === exclude) continue;
      const f = rb.frames;
      for (let i = 0; i < f.length - 1; i++) {
        const a = f[i];
        const b = f[i + 1];
        const segLen = b.s - a.s;
        if (segLen <= 1e-6) continue;
        _d.subVectors(p, a.position);
        const along = _d.dot(a.forward);
        if (along < -0.05 || along > segLen + 0.05) continue;
        const t = Math.min(1, Math.max(0, along / segLen));
        _p.lerpVectors(a.position, b.position, t);
        _up.lerpVectors(a.up, b.up, t).normalize();
        _rt.lerpVectors(a.right, b.right, t).normalize();
        _d.subVectors(p, _p);
        const h = _d.dot(_up);
        if (h < -tol || h > maxDistance) continue;
        const lateral = _d.dot(_rt);
        const hw = rb.halfWidths[i] + (rb.halfWidths[i + 1] - rb.halfWidths[i]) * t;
        if (Math.abs(lateral) > hw + lateralMargin) continue;
        if (best && h >= best.distance) continue;
        _fw.lerpVectors(a.forward, b.forward, t).normalize();
        best = {
          point: p.clone().addScaledVector(_up, -h),
          normal: _up.clone(),
          forward: _fw.clone(),
          right: _rt.clone(),
          distance: h,
          ribbon: rb,
          box: null,
          s: a.s + segLen * t,
          lateral,
          halfWidth: hw,
        };
      }
    }
    for (let k = 0; k < this.boxes.length; k++) {
      const bx = this.boxes[k];
      const [sx, sy, sz] = bx.piece.size;
      _p.copy(p).applyMatrix4(this.boxInv[k]);
      if (Math.abs(_p.x) > sx / 2 + lateralMargin || Math.abs(_p.z) > sz / 2 + lateralMargin) continue;
      const h = _p.y - sy / 2;
      if (h < -tol || h > maxDistance) continue;
      if (best && h >= best.distance) continue;
      const up = new Vector3(0, 1, 0).applyQuaternion(bx.quaternion);
      best = {
        point: p.clone().addScaledVector(up, -h),
        normal: up,
        forward: new Vector3(0, 0, -1).applyQuaternion(bx.quaternion),
        right: new Vector3(1, 0, 0).applyQuaternion(bx.quaternion),
        distance: h,
        ribbon: null,
        box: bx,
        s: 0,
        lateral: _p.x,
        halfWidth: sx / 2,
      };
    }
    return best;
  }

  /**
   * Heights where the world-vertical line at (x, z) crosses a deck between yTop and yBottom
   * (top surfaces and slab undersides both count as "blocked"). Sorted from top to bottom.
   * `skip` lets a ribbon ignore itself near arc length `skipS` (± skipRadius).
   */
  verticalHits(
    x: number,
    z: number,
    yTop: number,
    yBottom: number,
    margin = 1.5,
    skip?: { ribbon: RibbonInfo; s: number; radius: number },
  ): number[] {
    const out: number[] = [];
    for (const rb of this.ribbons) {
      const f = rb.frames;
      for (let i = 0; i < f.length - 1; i++) {
        const a = f[i];
        if (skip && skip.ribbon === rb && Math.abs(a.s - skip.s) < skip.radius) continue;
        // horizontal footprint test in the segment's local frame (approximate with frame a)
        const b = f[i + 1];
        const dx = x - a.position.x;
        const dz = z - a.position.z;
        // horizontal forward / right of the segment
        const fx = b.position.x - a.position.x;
        const fz = b.position.z - a.position.z;
        const fl = Math.hypot(fx, fz);
        const hw = rb.halfWidths[i] + margin;
        if (fl < 1e-4) {
          // vertical segment: footprint is the slab cross-section; treat as point-ish
          if (Math.hypot(dx, dz) > hw) continue;
          const y = Math.max(a.position.y, b.position.y);
          if (y <= yTop && y >= yBottom) out.push(y);
          continue;
        }
        const along = (dx * fx + dz * fz) / fl;
        if (along < 0 || along > fl) continue;
        const lat = Math.abs((dx * fz - dz * fx) / fl);
        // lateral extent projected on the horizontal plane
        const rh = Math.hypot(a.right.x, a.right.z);
        if (lat > hw * Math.max(rh, 0.05) + margin) continue;
        const t = along / fl;
        const y = a.position.y + (b.position.y - a.position.y) * t;
        if (y <= yTop && y >= yBottom) out.push(y);
      }
    }
    for (let k = 0; k < this.boxes.length; k++) {
      const bx = this.boxes[k];
      const [sx, sy, sz] = bx.piece.size;
      _p.set(x, (yTop + yBottom) / 2, z).applyMatrix4(this.boxInv[k]);
      if (Math.abs(_p.x) > sx / 2 + margin || Math.abs(_p.z) > sz / 2 + margin) continue;
      const topY = new Vector3(_p.x, sy / 2, _p.z).applyMatrix4(bx.matrix).y;
      if (topY <= yTop && topY >= yBottom) out.push(topY);
    }
    return out.sort((p, q) => q - p);
  }
}
