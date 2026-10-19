/**
 * The Kickflip lineup: five stylized vehicles (cab, angular pickup, semi-truck cab, two sedans) built
 * from extruded side profiles, wheels and an emissive light bar. Render only; collision blocks are in
 * the LevelDef. Each vehicle: length along local +X (nose at +X), width along Z, ground at y = 0.
 */
import { useMemo } from 'react';
import { ExtrudeGeometry, Shape } from 'three';
import type { KfVehicle, KfVehicleKind } from '@/game/levels/kickflip/layout';

const DEG = Math.PI / 180;

/** Side profiles as fractions of [length, height] (x from tail -0.5 → nose +0.5, y from 0 up). */
const PROFILES: Record<KfVehicleKind, [number, number][]> = {
  sedan: [[-0.5, 0.18], [-0.5, 0.52], [-0.38, 0.6], [-0.22, 1], [0.08, 1], [0.3, 0.62], [0.5, 0.48], [0.5, 0.18]],
  cab: [[-0.5, 0.2], [-0.48, 0.62], [-0.2, 1], [0.12, 0.98], [0.42, 0.58], [0.5, 0.42], [0.5, 0.2]],
  pickup: [[-0.5, 0.25], [-0.5, 0.62], [0.02, 1], [0.5, 0.6], [0.5, 0.25]],
  semi: [[-0.5, 0.16], [-0.5, 0.36], [-0.05, 0.36], [-0.04, 0.96], [0.12, 1], [0.38, 0.86], [0.5, 0.42], [0.5, 0.16]],
};
const GLASS: Record<KfVehicleKind, [number, number][] | null> = {
  sedan: [[-0.33, 0.62], [-0.2, 0.93], [0.06, 0.93], [0.25, 0.63]],
  cab: [[-0.42, 0.64], [-0.18, 0.93], [0.1, 0.92], [0.36, 0.6]],
  pickup: [[-0.12, 0.83], [0.02, 0.95], [0.28, 0.79], [0.14, 0.76]],
  semi: [[0.12, 0.93], [0.36, 0.84], [0.44, 0.58], [0.2, 0.62]],
};
const WHEELS: Record<KfVehicleKind, { x: number[]; r: number }> = {
  sedan: { x: [-0.32, 0.32], r: 0.36 },
  cab: { x: [-0.32, 0.3], r: 0.34 },
  pickup: { x: [-0.33, 0.33], r: 0.45 },
  semi: { x: [-0.38, -0.22, 0.34], r: 0.52 },
};

function extrude(points: [number, number][], len: number, h: number, depth: number, bevel: number) {
  const s = new Shape();
  points.forEach(([x, y], i) => (i === 0 ? s.moveTo(x * len, y * h) : s.lineTo(x * len, y * h)));
  s.closePath();
  const g = new ExtrudeGeometry(s, { depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2 });
  g.translate(0, 0, -depth / 2);
  return g;
}

function Vehicle({ v }: { v: KfVehicle }) {
  const [len, h, w] = v.size;
  const geo = useMemo(() => {
    const body = extrude(PROFILES[v.kind], len, h, w - 0.16, 0.08);
    const g = GLASS[v.kind];
    const glass = g ? extrude(g, len, h, w + 0.02, 0) : null;
    return { body, glass };
  }, [v.kind, len, h, w]);
  const wheels = WHEELS[v.kind];
  const noseX = len / 2 + 0.06;
  const lightY = h * (v.kind === 'semi' ? 0.45 : 0.5);
  return (
    <group position={v.position} rotation={[0, v.yawDeg * DEG, 0]}>
      <mesh geometry={geo.body} castShadow receiveShadow>
        <meshPhysicalMaterial color={v.paint} metalness={0.55} roughness={0.28} clearcoat={1} clearcoatRoughness={0.08} />
      </mesh>
      {geo.glass && (
        <mesh geometry={geo.glass}>
          <meshPhysicalMaterial color="#0b0d10" metalness={0.2} roughness={0.05} clearcoat={1} />
        </mesh>
      )}
      {/* full-width light bar at the nose, red bar at the tail */}
      <mesh position={[noseX, lightY, 0]}>
        <boxGeometry args={[0.04, 0.05, w * 0.9]} />
        <meshBasicMaterial color="#e8f4ff" toneMapped={false} />
      </mesh>
      <mesh position={[-noseX, lightY + 0.05, 0]}>
        <boxGeometry args={[0.04, 0.05, w * 0.9]} />
        <meshBasicMaterial color="#ff2b3d" toneMapped={false} />
      </mesh>
      {wheels.x.map((fx) =>
        [-1, 1].map((side) => (
          <mesh key={`${fx}${side}`} position={[fx * len, wheels.r, side * (w / 2 - 0.12)]} rotation={[Math.PI / 2, 0, 0]} castShadow>
            <cylinderGeometry args={[wheels.r, wheels.r, 0.3, 24]} />
            <meshStandardMaterial color="#121314" roughness={0.85} />
          </mesh>
        )),
      )}
    </group>
  );
}

export function Lineup({ vehicles }: { vehicles: KfVehicle[] }) {
  return (
    <group>
      {vehicles.map((v, i) => (
        <Vehicle key={i} v={v} />
      ))}
    </group>
  );
}
