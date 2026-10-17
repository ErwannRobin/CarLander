import { useFrame } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, Vector2, Vector3, Vector4, type PerspectiveCamera } from 'three';
import type { AtmosphereUniforms } from './atmosphere';
import { useEnv } from './context';
import { SKY_FRAGMENT, SKY_VERTEX } from './shaders/sky';
import { getCloudNoiseTexture } from './textures';
import type { ThemeDef } from './themes';

const DEG = Math.PI / 180;

/** Creates a sky material bound to the shared atmosphere uniforms. `envMode` = reflection-env variant. */
export function createSkyMaterial(atmosphere: AtmosphereUniforms, envMode: boolean): ShaderMaterial {
  return new ShaderMaterial({
    name: envMode ? 'env.skyEnv' : 'env.sky',
    uniforms: {
      ...atmosphere,
      uNoise: { value: getCloudNoiseTexture() },
      uSunDisk: { value: new Vector3() },
      uSunColor: { value: new Color() },
      uCirrus: { value: new Vector4() },
      uCirrusColor: { value: new Color() },
      uCirrusDrift: { value: new Vector2() },
      uStars: { value: new Vector2() },
      uPixelAngle: { value: 0.0012 },
      uEnvMode: { value: envMode ? 1 : 0 },
    },
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    side: BackSide,
    depthWrite: false,
    fog: false,
  });
}

/** Writes the theme-specific (non-shared) sky uniforms. */
export function applySkyTheme(material: ShaderMaterial, theme: ThemeDef): void {
  const u = material.uniforms;
  const disk = theme.sun.disk;
  (u.uSunDisk.value as Vector3).set(disk ? Math.sin(disk.size * DEG) : 0.01, disk ? disk.intensity : 0, disk ? 1 : 0);
  (u.uSunColor.value as Color).set(theme.sun.color);
  const c = theme.sky.cirrus;
  (u.uCirrus.value as Vector4).set(c.coverage, c.opacity, c.scale, c.speed);
  (u.uCirrusColor.value as Color).set(c.color);
  (u.uStars.value as Vector2).set(theme.sky.stars.density, theme.sky.stars.intensity);
}

/** Advances the cirrus drift (texture-space, wrapped so precision never degrades). */
export function advanceCirrus(material: ShaderMaterial, theme: ThemeDef, dt: number): void {
  const d = material.uniforms.uCirrusDrift.value as Vector2;
  const k = 0.000045 * theme.sky.cirrus.speed;
  d.x = (d.x + theme.clouds.wind[0] * k * dt) % 1;
  d.y = (d.y + theme.clouds.wind[1] * k * dt) % 1;
}

/**
 * Camera-centered sky dome: gradient, haze band, sun disk + glow, high cirrus, stars at night.
 * Rendered at the far plane after all opaque geometry (renderOrder 1000) so it only shades
 * uncovered pixels.
 */
export function Sky() {
  const { atmosphere, theme } = useEnv();
  const geometry = useMemo(() => new SphereGeometry(1000, 48, 24), []);
  const material = useMemo(() => createSkyMaterial(atmosphere, false), [atmosphere]);
  const ref = useRef<Mesh>(null);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );
  // layout effect: the first rendered frame already has the theme's disk / cirrus / stars
  useLayoutEffect(() => applySkyTheme(material, theme), [material, theme]);

  useFrame((state, delta) => {
    const mesh = ref.current;
    if (!mesh) return;
    mesh.position.copy(state.camera.position);
    const fov = (state.camera as PerspectiveCamera).fov ?? 60;
    const pixels = Math.max(1, state.size.height * state.viewport.dpr);
    material.uniforms.uPixelAngle.value = (fov * DEG) / pixels;
    advanceCirrus(material, theme, Math.min(delta, 0.1));
  });

  return <mesh ref={ref} geometry={geometry} material={material} renderOrder={1000} frustumCulled={false} />;
}
