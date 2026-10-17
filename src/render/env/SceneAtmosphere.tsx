import { useThree } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { FogExp2, type HemisphereLight } from 'three';
import { useEnv } from './context';

/**
 * Scene-level atmosphere for standard materials: FogExp2 (same density / color family as the
 * far-field shaders) and a hemisphere fill light (sky above, cloud-floor bounce below).
 */
export function SceneAtmosphere({ fog = true }: { fog?: boolean }) {
  const { theme } = useEnv();
  const scene = useThree((s) => s.scene);
  const hemi = useRef<HemisphereLight>(null);
  const fogObj = useMemo(() => new FogExp2('#ffffff', 0), []);

  // install / remove the fog (keeps a single FogExp2 instance so materials never recompile)
  useLayoutEffect(() => {
    if (!fog) return;
    const prev = scene.fog;
    scene.fog = fogObj;
    return () => {
      if (scene.fog === fogObj) scene.fog = prev;
    };
  }, [scene, fogObj, fog]);

  useLayoutEffect(() => {
    fogObj.color.set(theme.fog.color);
    fogObj.density = theme.fog.density;
    const h = hemi.current;
    if (h) {
      h.color.set(theme.hemi.sky);
      h.groundColor.set(theme.hemi.ground);
      h.intensity = theme.hemi.intensity;
    }
  }, [theme, fogObj]);

  return <hemisphereLight ref={hemi} />;
}
