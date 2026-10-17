/**
 * Soft additive light pools conformed onto a ribbon's drive surface (render only): the look of a
 * floodlight hitting the concrete without spending a real light. Each pool is an elliptical
 * falloff (along the ribbon × across it) baked into vertex colors; all pools of one component are
 * merged into a single mesh (1 draw call).
 */
import { useEffect, useMemo } from 'react';
import { AdditiveBlending, Color, DoubleSide, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import type { TrackFrame } from '@/game/types';
import { frameAt } from '@/game/track/TrackPath';
import { GeoBuilder } from '@/render/level/geometry/GeoBuilder';

export interface GlowPool {
  /** Arc length (on `frames`) of the pool center and its half length along the ribbon (m). */
  s: number;
  halfLength: number;
  /** Half width across the ribbon (m) and lateral center offset (+ = right). */
  halfWidth: number;
  offset?: number;
  /** Peak strength 0..1 (multiplies `color`). */
  strength?: number;
}

export interface SurfaceGlowProps {
  frames: TrackFrame[];
  pools: GlowPool[];
  /** Linear HDR tint at full strength. Default warm floodlight white × 0.55. */
  color?: string;
  intensity?: number;
  /** Height above the drive surface along the frame up (m). */
  lift?: number;
}

const _p = new Vector3();

/** Smooth bell: 1 at 0, 0 at |x| >= 1. */
function bell(x: number): number {
  const a = Math.min(1, Math.abs(x));
  const t = 1 - a * a;
  return t * t;
}

export function SurfaceGlow({ frames, pools, color = '#fff2df', intensity = 0.55, lift = 0.035 }: SurfaceGlowProps) {
  const key = JSON.stringify(pools);
  const mesh = useMemo(() => {
    const b = new GeoBuilder().withColors();
    for (const pool of pools) {
      const rows = Math.max(8, Math.round(pool.halfLength / 1.5));
      const cols = 10;
      const k0 = pool.strength ?? 1;
      const off = pool.offset ?? 0;
      const ids: number[][] = [];
      for (let j = 0; j <= rows; j++) {
        const v = (j / rows) * 2 - 1;
        const f = frameAt(frames, pool.s + v * pool.halfLength);
        const row: number[] = [];
        for (let i = 0; i <= cols; i++) {
          const u = (i / cols) * 2 - 1;
          _p.copy(f.position)
            .addScaledVector(f.right, off + u * pool.halfWidth)
            .addScaledVector(f.up, lift);
          const k = k0 * bell(v) * bell(u * 0.92);
          row.push(b.vertex(_p, f.up, u, v));
          b.color(k, k, k);
        }
        ids.push(row);
      }
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) b.quad(ids[j][i], ids[j][i + 1], ids[j + 1][i + 1], ids[j + 1][i]);
    }
    const mat = new MeshBasicMaterial({
      color: new Color(color).multiplyScalar(intensity),
      vertexColors: true,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    const m = new Mesh(b.build(), mat);
    m.name = 'l3-surface-glow';
    m.renderOrder = 1;
    m.matrixAutoUpdate = false;
    return m;
    // pools are compared by value (key)
  }, [frames, key, color, intensity, lift]);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as MeshBasicMaterial).dispose();
    },
    [mesh],
  );
  return <primitive object={mesh} />;
}
