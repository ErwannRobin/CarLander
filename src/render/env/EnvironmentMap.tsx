import { useThree } from '@react-three/fiber';
import { useLayoutEffect } from 'react';
import {
  CircleGeometry,
  Color,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
} from 'three';
import { useEnv } from './context';
import { applySkyTheme, createSkyMaterial } from './Sky';
import { directionFromAngles } from './themes';

const _origin = new Vector3();

/**
 * Generates `scene.environment` in-scene: the theme sky (cloud floor below the horizon, no sun disk —
 * the directional light already provides the specular sun) plus a few emissive "lightformer" cards
 * for studio-style highlights on the paint, prefiltered with PMREM.
 *
 * Regenerated only when the theme (or env map resolution) changes; restores the previous
 * environment on unmount.
 */
export function EnvironmentMap() {
  const { atmosphere, theme, quality } = useEnv();
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const size = quality.envMapSize;

  // Layout effect: the environment exists before the first frame, so lit materials compile once
  // with their env-map variant instead of compiling, then recompiling a frame later.
  useLayoutEffect(() => {
    const pmrem = new PMREMGenerator(gl);
    const envScene = new Scene();
    const disposables: { dispose(): void }[] = [pmrem];

    const skyGeo = new SphereGeometry(400, 64, 32);
    const skyMat = createSkyMaterial(atmosphere, true);
    applySkyTheme(skyMat, theme);
    envScene.add(new Mesh(skyGeo, skyMat));
    disposables.push(skyGeo, skyMat);

    for (const lf of theme.env.lightformers) {
      const geo: BufferGeometry = lf.shape === 'disc' ? new CircleGeometry(0.5, 48) : new PlaneGeometry(1, 1);
      const mat = new MeshBasicMaterial({
        color: new Color(lf.color).multiplyScalar(lf.intensity),
        side: DoubleSide,
        toneMapped: false,
        fog: false,
      });
      const card = new Mesh(geo, mat);
      directionFromAngles(lf.elevationDeg, lf.azimuthDeg, card.position).multiplyScalar(lf.distance);
      card.scale.set(lf.size[0], lf.size[1], 1);
      card.lookAt(_origin);
      envScene.add(card);
      disposables.push(geo, mat);
    }

    const target = pmrem.fromScene(envScene, 0, 0.5, 1000, { size });
    for (const d of disposables) d.dispose();

    const prevEnv = scene.environment;
    const prevIntensity = scene.environmentIntensity;
    scene.environment = target.texture;
    scene.environmentIntensity = theme.env.intensity;

    return () => {
      if (scene.environment === target.texture) {
        scene.environment = prevEnv;
        scene.environmentIntensity = prevIntensity;
      }
      target.dispose();
    };
  }, [gl, scene, atmosphere, theme, size]);

  return null;
}
