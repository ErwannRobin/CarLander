import { Canvas, useThree } from '@react-three/fiber';
import { useEffect, type ReactNode } from 'react';
import { NoToneMapping, PCFShadowMap, SRGBColorSpace } from 'three';
import type { QualityPreset } from '@/config/quality';

function RendererSetup() {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    gl.shadowMap.type = PCFShadowMap; // r186 removed PCFSoft; softness comes from shadow.radius
    gl.toneMapping = NoToneMapping; // tone mapping is done in PostFX
    gl.outputColorSpace = SRGBColorSpace;
  }, [gl]);
  return null;
}

/** The single persistent WebGL canvas (title preview + gameplay share it). */
export function GameCanvas({ quality, children }: { quality: QualityPreset; children: ReactNode }) {
  return (
    <Canvas
      shadows
      flat
      dpr={[1, quality.dpr]}
      gl={{ antialias: false, powerPreference: 'high-performance', stencil: false, alpha: false }}
      camera={{ fov: 62, near: 0.1, far: 9000, position: [6, 3, 9] }}
      style={{ position: 'fixed', inset: 0, background: '#121417' }}
      onCreated={({ gl }) => {
        gl.domElement.addEventListener('webglcontextlost', (e) => e.preventDefault());
      }}
    >
      <RendererSetup />
      {children}
    </Canvas>
  );
}
