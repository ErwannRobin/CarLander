import { useFrame } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Color, Mesh, ShaderMaterial } from 'three';
import { useEnv } from './context';
import { createLandscapeGeometry } from './landscapeGeometry';
import { LANDSCAPE_FRAGMENT, LANDSCAPE_VERTEX } from './shaders/landscape';

/**
 * How much the landscape rings follow the camera horizontally (1 = locked to the camera, like a
 * skybox; 0 = static). Slightly below 1 keeps a hint of parallax while guaranteeing the rings
 * never get closer than ~2 km over a 3 km level.
 */
const FOLLOW = 0.9;

/** Mountain / mesa silhouette rings 2–7 km away with strong atmospheric fade. */
export function Landscape() {
  const { atmosphere, theme, quality } = useEnv();
  const land = theme.landscape;
  const ref = useRef<Mesh>(null);

  const geometry = useMemo(
    () => (land ? createLandscapeGeometry(land.kind, land.seed, quality.detail, land.height) : null),
    [land, quality.detail],
  );
  const material = useMemo(
    () =>
      new ShaderMaterial({
        name: 'env.landscape',
        uniforms: {
          ...atmosphere,
          uRockLit: { value: new Color() },
          uRockShade: { value: new Color() },
          uSnow: { value: new Color() },
          uSnowAmount: { value: 0 },
          uKind: { value: 0 },
          uSeaTop: { value: -160 },
          uAerial: { value: 1 },
        },
        vertexShader: LANDSCAPE_VERTEX,
        fragmentShader: LANDSCAPE_FRAGMENT,
        fog: false,
      }),
    [atmosphere],
  );

  useEffect(() => () => geometry?.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  // layout effect: never render a frame with the default (black) rock colors
  useLayoutEffect(() => {
    if (!land) return;
    const u = material.uniforms;
    (u.uRockLit.value as Color).set(land.color);
    (u.uRockShade.value as Color).set(land.shade);
    (u.uSnow.value as Color).set(land.snow ?? '#ffffff');
    u.uSnowAmount.value = land.snow ? 1 : 0;
    u.uKind.value = land.kind === 'mesas' ? 1 : 0;
    u.uSeaTop.value = theme.clouds.seaTop;
    u.uAerial.value = land.haze;
  }, [land, material, theme]);

  useFrame((state) => {
    const mesh = ref.current;
    if (!mesh) return;
    const c = state.camera.position;
    mesh.position.set(c.x * FOLLOW, theme.clouds.seaTop, c.z * FOLLOW);
  });

  if (!geometry) return null;
  return <mesh ref={ref} geometry={geometry} material={material} renderOrder={900} frustumCulled={false} />;
}
