/**
 * Canvas wrapper for dev sandbox pages — mirrors the production canvas configuration so what you
 * see in a sandbox matches the game:
 *  - sRGB output, renderer tone mapping OFF (`flat`) — tone mapping is done by the PostFX stack;
 *    if a sandbox renders without PostFX, pass `toneMapped` to use ACES on the renderer instead.
 *  - shadows enabled (PCFSoft), antialias off (the composer does MSAA/SMAA)
 *  - camera fov 62, near 0.1, far 8000
 * Sets `window.__shotReady = true` after `readyFrames` rendered frames (for scripts/shot.mjs --ready).
 */
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { useEffect, useRef, type ReactNode } from 'react';
import { ACESFilmicToneMapping, NoToneMapping, PCFShadowMap } from 'three';

function ReadySignal({ frames }: { frames: number }) {
  const n = useRef(0);
  useFrame(() => {
    n.current++;
    if (n.current === frames) (window as unknown as { __shotReady: boolean }).__shotReady = true;
  });
  return null;
}

function RendererSetup({ toneMapped }: { toneMapped: boolean }) {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    gl.shadowMap.type = PCFShadowMap;
    gl.toneMapping = toneMapped ? ACESFilmicToneMapping : NoToneMapping;
    gl.toneMappingExposure = 1;
  }, [gl, toneMapped]);
  return null;
}

export function DevCanvas({
  children,
  camera = { position: [6, 3, 8] as [number, number, number], fov: 62 },
  orbit = true,
  orbitTarget = [0, 0.5, 0] as [number, number, number],
  toneMapped = false,
  readyFrames = 30,
  dpr = 1.5,
  background,
}: {
  children: ReactNode;
  camera?: { position: [number, number, number]; fov?: number };
  orbit?: boolean;
  orbitTarget?: [number, number, number];
  toneMapped?: boolean;
  readyFrames?: number;
  dpr?: number;
  background?: string;
}) {
  return (
    <Canvas
      shadows
      flat
      dpr={[1, dpr]}
      gl={{ antialias: false, powerPreference: 'high-performance', stencil: false }}
      camera={{ position: camera.position, fov: camera.fov ?? 62, near: 0.1, far: 8000 }}
      style={{ position: 'fixed', inset: 0 }}
    >
      {background && <color attach="background" args={[background]} />}
      <RendererSetup toneMapped={toneMapped} />
      <ReadySignal frames={readyFrames} />
      {orbit && <OrbitControls target={orbitTarget} makeDefault />}
      {children}
    </Canvas>
  );
}
