/**
 * Cyan guide chevrons inlaid in the approach lane, pointing at the crescent entry (render only:
 * 3 cm above the drive surface, no physics). One merged mesh, one draw call.
 */
import { useEffect, useMemo } from 'react';
import { Color, DoubleSide, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import type { TrackFrame } from '@/game/types';
import { frameAt } from '@/game/track/TrackPath';
import { PALETTE } from '@/render/palette';
import { GeoBuilder } from '@/render/level/geometry/GeoBuilder';

export interface LaneChevronsProps {
  frames: TrackFrame[];
  /** Arc lengths (on `frames`) of the chevron tips. */
  at: number[];
  /** Chevron span across the lane and depth along it (m). */
  span: number;
  depth: number;
  /** Bar width (m). */
  bar?: number;
  /** Emissive multiplier (night bloom threshold ≈ 0.85 luminance). */
  intensity?: number;
}

const _p = new Vector3();

export function LaneChevrons({ frames, at, span, depth, bar = 0.7, intensity = 1.5 }: LaneChevronsProps) {
  const mesh = useMemo(() => {
    const b = new GeoBuilder();
    const n = 8;
    for (const s of at) {
      for (const side of [-1, 1]) {
        // arm from the outer back corner (side * span / 2, -depth) to the tip (0, 0), in
        // (lateral, along) lane coordinates; the bar is offset along the arm's normal
        const dl = -side * (span / 2);
        const da = depth;
        const len = Math.hypot(dl, da);
        const nl = da / len;
        const na = -dl / len;
        const ids: number[][] = [];
        for (let k = 0; k <= n; k++) {
          const t = k / n;
          const row: number[] = [];
          for (const e of [-0.5, 0.5]) {
            const lateral = side * (span / 2) * (1 - t) + e * bar * nl;
            const along = -depth * (1 - t) + e * bar * na;
            const f = frameAt(frames, s + along);
            _p.copy(f.position).addScaledVector(f.right, lateral).addScaledVector(f.up, 0.03);
            row.push(b.vertex(_p, f.up, e + 0.5, t));
          }
          ids.push(row);
        }
        for (let k = 0; k < n; k++) b.quad(ids[k][0], ids[k][1], ids[k + 1][1], ids[k + 1][0]);
      }
    }
    const geo = b.build();
    const mat = new MeshBasicMaterial({
      color: new Color(PALETTE.cyan).multiplyScalar(intensity),
      toneMapped: false,
      fog: true,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const m = new Mesh(geo, mat);
    m.name = 'l3-lane-chevrons';
    m.renderOrder = 1;
    m.matrixAutoUpdate = false;
    return m;
  }, [frames, at, span, depth, bar, intensity]);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as MeshBasicMaterial).dispose();
    },
    [mesh],
  );
  return <primitive object={mesh} />;
}
