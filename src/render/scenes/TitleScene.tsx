/**
 * Title / menu backdrop: the hero car on a floating plinth high above the clouds at golden hour,
 * with a slow cinematic orbit. The car sits right of center to leave room for the wordmark.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import { AdditiveBlending, Color, PerspectiveCamera, Vector3 } from 'three';
import type { QualityPreset } from '@/config/quality';
import { runtime } from '@/game/runtime';
import { VEHICLE } from '@/game/vehicleSpec';
import { ShowroomCar } from '@/render/car';
import { World } from '@/render/env';
import { PALETTE } from '@/render/palette';
import { PostFX } from '@/render/post';

const PLINTH_TOP = 0;
const CAR_Y = PLINTH_TOP - VEHICLE.groundY;

const target = new Vector3();
const right = new Vector3();
const fwd = new Vector3();

function TitleCamera({ variant }: { variant: 'title' | 'menu' }) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const size = useThree((s) => s.size);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const portrait = size.height > size.width * 1.1;
    const a = 0.55 + t * 0.045 + (variant === 'menu' ? 0.9 : 0);
    const radius = portrait ? 11.5 : 8.2;
    const y = (portrait ? 3.4 : 1.35) + Math.sin(t * 0.21) * 0.12;
    camera.position.set(Math.cos(a) * radius, CAR_Y + y, Math.sin(a) * radius);
    target.set(0, CAR_Y + 0.15, 0);
    fwd.copy(target).sub(camera.position).normalize();
    right.crossVectors(fwd, camera.up).normalize();
    // push the car to the right third (look left of it) on wide screens; on portrait screens put it
    // in the lower half, under the wordmark and the buttons
    const shift = portrait ? 0 : variant === 'menu' ? 2.4 : 2.1;
    target.addScaledVector(right, -shift);
    if (portrait) target.y += 3.1;
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
    const fov = portrait ? 56 : 38;
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  });
  return null;
}

function Plinth() {
  const ringColor = useMemo(() => new Color(PALETTE.cyan).multiplyScalar(2.2), []);
  return (
    <group position={[0, PLINTH_TOP, 0]}>
      {/* polished dark top */}
      <mesh receiveShadow position={[0, -0.06, 0]}>
        <cylinderGeometry args={[4.6, 4.6, 0.12, 128]} />
        <meshPhysicalMaterial color={PALETTE.graphite800} roughness={0.22} metalness={0.2} clearcoat={0.6} clearcoatRoughness={0.15} />
      </mesh>
      {/* titanium bevel */}
      <mesh position={[0, -0.16, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[4.68, 4.4, 0.12, 128]} />
        <meshStandardMaterial color={PALETTE.titanium300} roughness={0.35} metalness={1} />
      </mesh>
      {/* monolithic base tapering into the void */}
      <mesh position={[0, -2.6, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[4.3, 1.6, 4.8, 96, 1, true]} />
        <meshStandardMaterial color={PALETTE.warmWhite2} roughness={0.55} metalness={0.05} />
      </mesh>
      {/* thin cyan light ring */}
      <mesh position={[0, 0.005, 0]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[4.42, 4.5, 160]} />
        <meshBasicMaterial color={ringColor} toneMapped={false} />
      </mesh>
      {/* soft contact glow under the car */}
      <mesh position={[0, 0.004, 0]} rotation-x={-Math.PI / 2}>
        <circleGeometry args={[3.2, 64]} />
        <meshBasicMaterial color={PALETTE.cyanDeep} transparent opacity={0.05} blending={AdditiveBlending} depthWrite={false} />
      </mesh>
    </group>
  );
}

export function TitleScene({ quality, variant }: { quality: QualityPreset; variant: 'title' | 'menu' }) {
  useEffect(() => {
    // sun / shadow camera follows runtime.frame.position: center it on the plinth
    runtime.level = null;
    runtime.frame.position.set(0, CAR_Y, 0);
    runtime.frame.quaternion.identity();
    runtime.frame.paused = true;
  }, []);
  useFrame((state, delta) => {
    runtime.frame.dt = Math.min(0.1, delta);
    runtime.frame.simDt = 0;
    runtime.frame.time = state.clock.elapsedTime;
  }, -100);
  return (
    <>
      <World theme="title" quality={quality} />
      <Plinth />
      <group position={[0, CAR_Y, 0]} rotation-y={-0.35}>
        <ShowroomCar />
      </group>
      <TitleCamera variant={variant} />
      <PostFX theme="title" quality={quality} />
    </>
  );
}
