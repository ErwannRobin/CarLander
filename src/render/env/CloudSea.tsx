import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { CircleGeometry, Mesh, NormalBlending, ShaderMaterial, Vector2, Vector4, type PerspectiveCamera } from 'three';
import { useEnv } from './context';
import { CLOUD_SEA_FRAGMENT, CLOUD_SEA_VERTEX } from './shaders/cloudSea';
import { getCloudNoiseTexture } from './textures';

const DEG = Math.PI / 180;
/** Disk radius (m). Stays inside the camera far plane (8–9 km) and fully hazed before its edge. */
const RADIUS = 7400;

/**
 * Immense cloud floor far below the facility (theme `clouds.seaTop` / `seaThickness`), drifting
 * slowly, sun-tinted, fading into the haze. One draw call; ray-march steps budgeted by
 * `quality.clouds`.
 */
export function CloudSea() {
  const { atmosphere, theme, quality } = useEnv();
  const steps = quality.clouds >= 0.95 ? 22 : quality.clouds >= 0.6 ? 15 : 10;
  const ref = useRef<Mesh>(null);

  const geometry = useMemo(() => new CircleGeometry(RADIUS, 96).rotateX(-Math.PI / 2), []);
  const material = useMemo(
    () =>
      new ShaderMaterial({
        name: 'env.cloudSea',
        defines: { STEPS: steps },
        uniforms: {
          ...atmosphere,
          uNoise: { value: getCloudNoiseTexture() },
          uDrift0: { value: new Vector2(0.37, 0.61) },
          uDrift1: { value: new Vector2(0.11, 0.83) },
          uBillowScale: { value: 900 },
          uPixelAngle: { value: 0.0012 },
          uDisk: { value: new Vector4(0, 0, RADIUS * 0.8, RADIUS) },
          uDeepOpacity: { value: 0.96 },
          uCloudBright: { value: 1.3 },
        },
        vertexShader: CLOUD_SEA_VERTEX,
        fragmentShader: CLOUD_SEA_FRAGMENT,
        transparent: true,
        premultipliedAlpha: true,
        blending: NormalBlending,
        depthWrite: false,
        fog: false,
      }),
    [atmosphere, steps],
  );

  // separate cleanups: a quality change recreates the material (STEPS define) but keeps the disk
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  useFrame((state, delta) => {
    const mesh = ref.current;
    if (!mesh) return;
    const cam = state.camera;
    mesh.position.set(cam.position.x, theme.clouds.seaTop, cam.position.z);
    const u = material.uniforms;
    (u.uDisk.value as Vector4).set(cam.position.x, cam.position.z, RADIUS * 0.8, RADIUS);
    const fov = (cam as PerspectiveCamera).fov ?? 60;
    u.uPixelAngle.value = (fov * DEG) / Math.max(1, state.size.height * state.viewport.dpr);

    // slow drift; billows move slightly faster than the masses so the floor evolves
    const dt = Math.min(delta, 0.1);
    const wx = theme.clouds.wind[0];
    const wz = theme.clouds.wind[1];
    const s = theme.clouds.scale;
    u.uCloudBright.value = theme.clouds.brightness;
    const sb = theme.clouds.billowScale;
    u.uBillowScale.value = sb;
    const d0 = u.uDrift0.value as Vector2;
    const d1 = u.uDrift1.value as Vector2;
    d0.set((d0.x + (wx * dt) / s) % 1, (d0.y + (wz * dt) / s) % 1);
    d1.set((d1.x + (wx * 1.35 * dt) / sb) % 1, (d1.y + (wz * 1.35 * dt) / sb) % 1);
  });

  return <mesh ref={ref} geometry={geometry} material={material} renderOrder={-20} frustumCulled={false} />;
}
