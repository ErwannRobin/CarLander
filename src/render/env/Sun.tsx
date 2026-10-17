import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { PCFShadowMap, Vector3, type DirectionalLight, type Object3D } from 'three';
import { runtime } from '@/game/runtime';
import { useEnv } from './context';
import { keyLightDirection } from './themes';

const WORLD_UP = new Vector3(0, 1, 0);
const _center = new Vector3();
const _fwd = new Vector3();
const _offset = new Vector3();

/** Shadow frustum half-extent (m) per shadow map size: ~2 cm texels on high. */
function shadowHalfExtent(mapSize: number): number {
  if (mapSize >= 4096) return 40;
  if (mapSize >= 2048) return 32;
  return 26;
}

/**
 * Shadow-casting key light (sun, or moonlight at night) that follows the car.
 *
 * - Tight orthographic frustum centered on `runtime.frame.position`, pushed ahead along the camera's
 *   horizontal view direction so the visible ground in front of the car is covered.
 * - The center is snapped to the shadow-map texel grid in light space, so translation never makes
 *   shadow edges shimmer (the light rotation is constant per theme).
 * - normalBias carries most of the acne protection (it scales naturally with grazing sun angles);
 *   the constant depth bias is tiny so contact shadows stay attached.
 */
export function Sun() {
  const { theme, quality } = useEnv();
  const gl = useThree((s) => s.gl);
  const lightRef = useRef<DirectionalLight>(null);
  const targetRef = useRef<Object3D>(null);

  /** Light-space basis matching DirectionalLightShadow's lookAt (camera.up = +Y). */
  const frame = useMemo(
    () => ({
      dir: new Vector3(0, 1, 0),
      right: new Vector3(1, 0, 0),
      up: new Vector3(0, 0, 1),
      distance: 300,
      half: 40,
      texel: 0.02,
      lookAhead: new Vector3(),
    }),
    [],
  );

  // r186 removed PCFSoftShadowMap (it warns and falls back); PCF + shadow.radius is the soft path.
  // Passive effect so it runs after the canvas' own renderer setup effect.
  useEffect(() => {
    if (gl.shadowMap.type !== PCFShadowMap) gl.shadowMap.type = PCFShadowMap;
  }, [gl]);

  useLayoutEffect(() => {
    const light = lightRef.current;
    const target = targetRef.current;
    if (!light || !target) return;
    light.target = target;

    const key = theme.keyLight ?? theme.sun;
    keyLightDirection(theme, frame.dir);
    frame.right.crossVectors(WORLD_UP, frame.dir);
    if (frame.right.lengthSq() < 1e-6) frame.right.set(1, 0, 0);
    frame.right.normalize();
    frame.up.crossVectors(frame.dir, frame.right).normalize();

    light.color.set(key.color);
    light.intensity = key.intensity;

    const castShadow = quality.shadows && key.intensity > 0;
    light.castShadow = castShadow;
    const mapSize = quality.shadowMapSize;
    const half = shadowHalfExtent(mapSize);
    frame.half = half;
    frame.texel = (2 * half) / mapSize;
    // far enough toward the light to include casters ~180 m above the car at low sun angles
    const sinEl = Math.max(0.12, frame.dir.y);
    frame.distance = Math.min(1500, Math.max(160, 180 / sinEl));

    const shadow = light.shadow;
    if (shadow.mapSize.x !== mapSize) {
      shadow.mapSize.set(mapSize, mapSize);
      shadow.map?.dispose();
      shadow.map = null;
    }
    const cam = shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 1;
    cam.far = frame.distance + 320;
    cam.updateProjectionMatrix();
    shadow.radius = theme.shadow.radius;
    shadow.intensity = theme.shadow.intensity;
    // ~2.5 texels of normal offset; depth bias expressed in world meters over the depth range
    shadow.normalBias = frame.texel * 2.4;
    shadow.bias = -0.012 / (cam.far - cam.near);
    shadow.needsUpdate = true;
  }, [theme, quality, frame]);

  useFrame((state, delta) => {
    const light = lightRef.current;
    const target = targetRef.current;
    if (!light || !target) return;

    // look-ahead along the camera's horizontal forward, smoothed so camera snaps don't pop coverage
    state.camera.getWorldDirection(_fwd);
    _fwd.y = 0;
    if (_fwd.lengthSq() > 1e-6) _fwd.normalize().multiplyScalar(frame.half * 0.45);
    const k = 1 - Math.exp(-Math.min(delta, 0.1) * 4);
    frame.lookAhead.lerp(_fwd, k);

    // a non-finite pose (sim blow-up) would poison the shadow camera: keep last frame's placement
    const p = runtime.frame.position;
    if (!Number.isFinite(p.x + p.y + p.z)) return;
    _center.copy(p).add(frame.lookAhead);

    // snap to the texel grid in light space
    const t = frame.texel;
    const cx = Math.round(_center.dot(frame.right) / t) * t;
    const cy = Math.round(_center.dot(frame.up) / t) * t;
    const cz = _center.dot(frame.dir);
    _offset.copy(frame.right).multiplyScalar(cx).addScaledVector(frame.up, cy).addScaledVector(frame.dir, cz);

    target.position.copy(_offset);
    target.updateMatrixWorld();
    light.position.copy(_offset).addScaledVector(frame.dir, frame.distance);
  });

  return (
    <>
      <directionalLight ref={lightRef} />
      <object3D ref={targetRef} />
    </>
  );
}
