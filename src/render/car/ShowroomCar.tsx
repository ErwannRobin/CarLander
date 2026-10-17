/**
 * <ShowroomCar/> — title-screen preview of the hero car: idle wheel pose (front wheels turned to
 * show the rims), slow light-bar breathing and a gentle suspension settle when it appears.
 *
 * Origin = chassis origin, exactly like <CarModel/> and <Car/> (centre line, mid wheelbase, axle
 * height at rest): a car resting on a floor at height h goes at y = h - VEHICLE.groundY, i.e.
 * 0.36 m above the floor. The settle / idle motions move the body on its springs while the tyres
 * stay planted on that floor.
 *
 *   <group position={[0, floorY - VEHICLE.groundY, 0]} rotation-y={-0.35}><ShowroomCar /></group>
 */
import { useFrame, type ThreeElements } from '@react-three/fiber';
import { useRef, useState } from 'react';
import type { ColorRepresentation } from 'three';
import { runtime } from '@/game/runtime';
import type { QualityLevel } from '@/game/types';
import { VEHICLE } from '@/game/vehicleSpec';
import { CarModel, type CarModelHandle } from './CarModel';

export type ShowroomCarProps = Omit<ThreeElements['group'], 'ref' | 'children'> & {
  paint?: ColorRepresentation;
  /** Front wheel steer angle in radians (+ = left). Default 0.3. */
  steer?: number;
  /** Light bar breathing (default true). */
  breathing?: boolean;
  /** Initial settle drop (m) when mounted (default 0.05; 0 disables). */
  settle?: number;
  shadows?: boolean;
  /** Material quality (default: runtime.quality.level when the car mounts). */
  quality?: QualityLevel;
};

/** Static spring length: the wheel centre sits at axle height (chassis y = 0). */
const REST: number = VEHICLE.suspension.hardpointY;
/** Light bar breathing period (s) and its intensity range (fraction of full). */
const BREATH_PERIOD = 4.8;
const BREATH_MIN = 0.62;

export function ShowroomCar({
  paint,
  steer = 0.3,
  breathing = true,
  settle = 0.05,
  shadows = true,
  quality,
  ...groupProps
}: ShowroomCarProps) {
  const model = useRef<CarModelHandle>(null);
  const [materialQuality] = useState<QualityLevel>(() => quality ?? runtime.quality.level);
  const t0 = useRef<number | null>(null);

  useFrame((state) => {
    const h = model.current;
    if (!h) return;
    const t = state.clock.elapsedTime;
    if (t0.current === null) t0.current = t;
    const age = t - t0.current;
    // damped drop into the springs, then an almost imperceptible "breathing" of the body
    const drop = settle * Math.exp(-age * 2.4) * Math.cos(age * 6.8);
    const idle = 0.0012 * Math.sin(t * 1.15);
    const lift = drop + idle;
    // the chassis rises by `lift` while the wheels stay planted: springs extend by the same amount
    h.group.position.set(0, lift, 0);
    for (let i = 0; i < 4; i++) h.setWheel(i, i < 2 ? steer : 0, 0, REST + lift, 0);
    // a hint of pitch as the nose settles slightly after the tail
    h.setBodyAttitude(-drop * 0.08, 0);
    const breath = 0.5 + 0.5 * Math.sin((t * Math.PI * 2) / BREATH_PERIOD);
    h.setLights(breathing ? BREATH_MIN + (1 - BREATH_MIN) * breath : 1);
    h.setBoost(0);
    h.setBrake(0);
    h.setVacuum(0);
  });

  return (
    <group {...groupProps}>
      <CarModel ref={model} paint={paint} shadows={shadows} quality={materialQuality} />
    </group>
  );
}
