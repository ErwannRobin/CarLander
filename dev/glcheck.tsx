import { createRoot } from 'react-dom/client';
import { Canvas, useFrame } from '@react-three/fiber';
import { Environment, Lightformer } from '@react-three/drei';
import { EffectComposer, Bloom, ToneMapping } from '@react-three/postprocessing';
import { useRef, useEffect } from 'react';
import type { Mesh } from 'three';
import '@/styles/base.css';

function Spin() {
  const m = useRef<Mesh>(null!);
  useFrame((_, dt) => (m.current.rotation.y += dt));
  useEffect(() => { setTimeout(() => ((window as any).__shotReady = true), 500); }, []);
  return (
    <mesh ref={m} castShadow>
      <torusKnotGeometry args={[1, 0.35, 256, 32]} />
      <meshPhysicalMaterial color="#e9ecef" metalness={0.6} roughness={0.25} clearcoat={1} />
    </mesh>
  );
}
createRoot(document.getElementById('root')!).render(
  <Canvas camera={{ position: [0, 1, 5] }} shadows gl={{ antialias: false }}>
    <color attach="background" args={['#1a1d21']} />
    <Spin />
    <Environment resolution={256}>
      <Lightformer intensity={4} position={[0, 5, -5]} scale={[10, 2, 1]} />
      <Lightformer intensity={2} color="#38e8ff" position={[-5, 1, 0]} rotation-y={Math.PI / 2} scale={[5, 1, 1]} />
    </Environment>
    <EffectComposer multisampling={4}>
      <Bloom mipmapBlur intensity={0.6} luminanceThreshold={0.9} />
      <ToneMapping />
    </EffectComposer>
  </Canvas>,
);
