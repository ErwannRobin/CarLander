/**
 * R3F wrappers for the custom effects. Each component owns its effect instance (disposed on
 * unmount), drives it from `runtime.frame` inside useFrame (no allocations, no React state) and
 * renders it as a <primitive> so any <EffectComposer> picks it up in child order.
 */
import { useFrame } from '@react-three/fiber';
import { useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
import { Vector3, type PerspectiveCamera } from 'three';
import { runtime } from '@/game/runtime';
import { NOZZLES } from '@/game/vehicleSpec';
import type { ThemeDef } from '@/render/env/themes';
import { FilmGradeEffect } from './FilmGradeEffect';
import { HeatDistortionEffect } from './HeatDistortionEffect';
import { SpeedFXEffect } from './SpeedFXEffect';

const KMH = 3.6;
/** Speed treatment ramps in above this speed and is full at the boosted top speed. */
export const SPEED_FX_START_KMH = 180;
export const SPEED_FX_FULL_KMH = 290;
/** Animation phases wrap here (seconds) so float precision never degrades in long sessions. */
const PHASE_WRAP = 1000;

const _p0 = new Vector3();
const _p1 = new Vector3();
const _uv = new Vector3();
const _viewSpace = new Vector3();
const _vel = new Vector3();

const smooth01 = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** Finite value or 0 (a NaN from the sim must never latch into the smoothed effect state). */
const finite = (v: number) => (Number.isFinite(v) ? v : 0);

/** Projects a world point to uv; returns the view distance (<= 0 behind the camera). */
function projectToUv(world: Vector3, camera: PerspectiveCamera, outUv: Vector3): number {
  _viewSpace.copy(world).applyMatrix4(camera.matrixWorldInverse);
  const dist = -_viewSpace.z;
  outUv.copy(_viewSpace).applyMatrix4(camera.projectionMatrix); // includes the perspective divide
  outUv.set(outUv.x * 0.5 + 0.5, outUv.y * 0.5 + 0.5, 0);
  return dist;
}

/**
 * Calls `onReset` on the 'reset' game event and whenever `runtime.runId` changes (a level load bumps
 * the run id without necessarily emitting 'reset'): smoothed effect state must not survive a restart.
 */
function useRunReset(state: { runId: number }, onReset: () => void): void {
  useEffect(() => runtime.events.on('reset', onReset), [onReset]);
  useFrame(() => {
    if (state.runId === runtime.runId) return;
    state.runId = runtime.runId;
    onReset();
  });
}

/**
 * Heat shimmer behind the rocket nozzles. Projects `NOZZLES` (vehicleSpec) with the interpolated
 * car pose every frame; plume length, radius and warp strength follow `vehicle.boostLevel`.
 */
export function HeatDistortion() {
  const effect = useMemo(() => new HeatDistortionEffect(), []);
  useEffect(() => () => effect.dispose(), [effect]);
  const state = useMemo(() => ({ boost: 0, runId: runtime.runId }), []);
  const onReset = useCallback(() => {
    state.boost = 0;
    effect.strength = 0;
  }, [state, effect]);
  useRunReset(state, onReset);

  useFrame((s, delta) => {
    const camera = s.camera as PerspectiveCamera;
    camera.updateMatrixWorld();
    const f = runtime.frame;
    const dt = Math.min(delta, 0.1);
    state.boost = finite(state.boost + (f.snapshot.vehicle.boostLevel - state.boost) * (1 - Math.exp(-dt * 10)));
    const b = state.boost;
    effect.phase = s.clock.elapsedTime % PHASE_WRAP;
    if (b < 0.01) {
      effect.strength = 0;
      return;
    }
    const halfFovTan = Math.tan(((camera.fov ?? 60) * Math.PI) / 360);
    const plume = 0.9 + 1.6 * b;
    let minR = Infinity;
    for (let i = 0; i < 2; i++) {
      const n = NOZZLES[i];
      _p0.set(n.position[0], n.position[1], n.position[2]).applyQuaternion(f.quaternion).add(f.position);
      _p1.set(n.position[0], n.position[1], n.position[2] + plume).applyQuaternion(f.quaternion).add(f.position);
      const seg = i === 0 ? effect.segA : effect.segB;
      const d0 = projectToUv(_p0, camera, _uv);
      seg.x = _uv.x;
      seg.y = _uv.y;
      const d1 = projectToUv(_p1, camera, _uv);
      seg.z = _uv.x;
      seg.w = _uv.y;
      // behind / too close to the camera, or a non-finite pose: no shimmer this frame
      if (!(d0 > 0.2 && d1 > 0.2) || !Number.isFinite(seg.x + seg.y + seg.z + seg.w)) {
        minR = 0;
        break;
      }
      // world radii -> uv-height units, capped so a plume blowing at the camera stays local
      const r1 = Math.min(0.1, (0.32 + 0.38 * b) / (2 * d1 * halfFovTan));
      const r0 = Math.min(r1, (0.18 + 0.1 * b) / (2 * d0 * halfFovTan));
      const r = effect.radii;
      if (i === 0) r.set(r0, r1, r.z, r.w);
      else r.set(r.x, r.y, r0, r1);
      minR = Math.min(minR, r1);
    }
    effect.strength = minR > 0 && minR < Infinity ? Math.min(0.0045, minR * 0.08) * b : 0;
  });

  return <primitive object={effect} />;
}

/**
 * Restrained high-speed treatment: radial blur toward the projected velocity direction + faint
 * peripheral streaks + very subtle chromatic dispersion in the smear, above 180 km/h and stronger
 * while boosting. Fades out when the motion is mostly sideways / backwards relative to the camera.
 */
export function SpeedFX({ samples = 10 }: { samples?: number }) {
  const effect = useMemo(() => new SpeedFXEffect({ samples }), [samples]);
  useEffect(() => () => effect.dispose(), [effect]);
  const state = useMemo(() => ({ amount: 0, boost: 0, runId: runtime.runId }), []);
  const onReset = useCallback(() => {
    state.amount = 0;
    state.boost = 0;
    effect.amount = 0;
    effect.streaks = 0;
    effect.aberration = 0;
  }, [state, effect]);
  useRunReset(state, onReset);

  useFrame((s, delta) => {
    const camera = s.camera as PerspectiveCamera;
    camera.updateMatrixWorld();
    const v = runtime.frame.snapshot.vehicle;
    const dt = Math.min(delta, 0.1);
    state.boost = finite(state.boost + (v.boostLevel - state.boost) * (1 - Math.exp(-dt * 6)));
    const b = state.boost;
    const base = smooth01(SPEED_FX_START_KMH, SPEED_FX_FULL_KMH, v.speed * KMH);
    let target = base * (0.6 + 0.4 * b);
    // focus of expansion: where the car is heading on screen
    _vel.copy(v.velocity);
    if (_vel.lengthSq() > 1) {
      _p0.copy(camera.position).addScaledVector(_vel.normalize(), 500);
      if (projectToUv(_p0, camera, _uv) <= 0) target = 0;
      else {
        const off = Math.max(Math.abs(_uv.x - 0.5), Math.abs(_uv.y - 0.5)) * 2;
        target *= 1 - smooth01(1.0, 1.8, off);
        effect.center.set(Math.min(1.3, Math.max(-0.3, _uv.x)), Math.min(1.3, Math.max(-0.3, _uv.y)));
      }
    } else target = 0;
    state.amount = finite(state.amount + (finite(target) - state.amount) * (1 - Math.exp(-dt * 4)));
    const a = state.amount < 0.002 ? 0 : state.amount;
    effect.amount = a;
    effect.streaks = a * (0.35 + 0.65 * b);
    effect.aberration = a * (0.35 + 0.25 * b);
    effect.phase = (s.clock.elapsedTime * 0.9) % PHASE_WRAP;
  });

  return <primitive object={effect} />;
}

/** Exposure + AgX/ACES tone mapping + finishing grade from a theme. Must be the last color effect. */
export function FilmGrade({ theme }: { theme: ThemeDef }) {
  const effect = useMemo(() => new FilmGradeEffect(), []);
  useEffect(() => () => effect.dispose(), [effect]);
  // layout effect: the first composed frame is already graded (no one-frame exposure flash)
  useLayoutEffect(() => effect.setTheme(theme), [effect, theme]);
  return <primitive object={effect} />;
}
