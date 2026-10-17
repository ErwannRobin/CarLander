/**
 * <CarModel/> — pure visual hero car (no runtime coupling).
 *
 * Origin = chassis origin (centre line, mid wheelbase, axle height at rest; see vehicleSpec).
 * Animate it imperatively through the ref handle — never via React state per frame.
 *
 *   const car = useRef<CarModelHandle>(null);
 *   useFrame(() => {
 *     car.current?.setWheel(0, steer, spin, suspensionLength, spinRate);
 *     car.current?.setBoost(level);
 *   });
 *   <CarModel ref={car} paint="#e9ecef" />
 */
import { useFrame, type ThreeElements } from '@react-three/fiber';
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { type ColorRepresentation, Euler, Group, Mesh, Vector3 } from 'three';
import type { QualityLevel } from '@/game/types';
import { HARDPOINTS, VEHICLE, WHEEL_POSITIONS } from '@/game/vehicleSpec';
import { PALETTE } from '@/render/palette';
import { acquireCarGeometry, peekCarGeometry, releaseCarGeometry } from './carAssets';
import { createCarMaterials, disposeCarMaterials, LIGHT_LEVELS } from './carMaterials';
import { ARCH_RADIUS } from './geometry/bodySurface';

export interface CarModelHandle {
  /** Root group at the chassis origin (set position/quaternion for the pose). */
  group: Group;
  /** Inner body group (everything except the wheels) for purely visual lean / squat. */
  body: Group;
  /**
   * Wheel pose in chassis space. i: 0 FL, 1 FR, 2 RL, 3 RR. steerAngle + = turned left (rears
   * usually 0), spinAngle + = rolling forward, suspensionLength = hardpoint -> wheel centre
   * distance (m). spinRate (rad/s) drives the anti-strobe blur; estimated from spinAngle deltas
   * when omitted. Non-finite inputs are ignored (the last valid pose is kept).
   */
  setWheel(i: number, steerAngle: number, spinAngle: number, suspensionLength: number, spinRate?: number): void;
  /** 0..1 rocket thrust level (nozzle throat glow). */
  setBoost(level: number): void;
  /** 0..1 vacuum suction strength (underbody grille glow). */
  setVacuum(strength: number): void;
  /** 0..1 brake level (rear light bar intensity). */
  setBrake(level: number): void;
  /** Running lights on/off, or a 0..1+ intensity level (e.g. showroom breathing). */
  setLights(on: boolean | number): void;
  /**
   * Visual body attitude relative to the wheels (radians / metres), applied about a low pivot.
   * Wheels that the lean brings closer to their arch are kept out of it (see visualSuspensionLength).
   */
  setBodyAttitude(pitch: number, roll: number, heave?: number): void;
}

export type CarModelProps = Omit<ThreeElements['group'], 'ref' | 'children'> & {
  ref?: Ref<CarModelHandle>;
  /** Body paint colour (default PALETTE.paint, pearl titanium white). */
  paint?: ColorRepresentation;
  /** Cast / receive shadows (default true). */
  shadows?: boolean;
  /**
   * Material quality, read once at mount (default 'high'). 'low' drops the pearl iridescence, the
   * sheen and the secondary clear coats (trim, titanium, rims) for a cheaper fragment shader.
   */
  quality?: QualityLevel;
};

/** Rest suspension length (static sag): wheel centre at axle height. */
const REST_LENGTH: number = VEHICLE.suspension.hardpointY;
/**
 * Wheel rise (m) above rest beyond which the visual travel is softly limited (arch clearance), and
 * the most it can add on top: the visual rise never exceeds SOFT_RISE + MAX_EXTRA_RISE (5.6 cm),
 * which keeps the tyre crown under the arch lip / fender skin even at full steer (verified with the
 * sandbox clearance sweep, dev/car.html?check=clearance). Physics compression beyond that is not
 * shown (the tyre then sits slightly into the ground for the few frames of a hard landing).
 */
const SOFT_RISE = 0.035;
const MAX_EXTRA_RISE = 0.021;
/** Spin-rate band (rad/s) over which spokes cross-fade to the blur dish. */
const BLUR_START = 13;
const BLUR_FULL = 34;
/** Body lean pivot (chassis space), near the roll centre. */
const PIVOT = new Vector3(0, -0.16, 0.05);
/** Height of the arch crown above each axle (chassis space): where tyre clearance is tightest. */
const ARCH_CROWN_Y = ARCH_RADIUS;

/**
 * Map a physics suspension length to the visual one: compression (the wheel rising towards its
 * arch) is softly limited so the tyre stays out of the bodywork; droop is untouched.
 * `bodyDrop` (m, + = down) is how far a visual body lean moved the arch towards this wheel — the
 * limit then applies to the wheel's rise relative to the leaned body. With the default 0 the result
 * depends on the physics length alone, which is what other modules should use to match the wheels.
 */
export function visualSuspensionLength(length: number, bodyDrop = 0): number {
  const rise = REST_LENGTH - length + bodyDrop;
  if (rise <= SOFT_RISE) return length;
  const extra = MAX_EXTRA_RISE * (1 - Math.exp(-(rise - SOFT_RISE) / MAX_EXTRA_RISE));
  return REST_LENGTH - (SOFT_RISE + extra) + bodyDrop;
}

const smooth01 = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** Clamp to 0..1; NaN maps to 0 (a NaN emissive would poison the bloom chain). */
const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0);
const finiteOr = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);

export function CarModel({ ref, paint = PALETTE.paint, shadows = true, quality = 'high', ...groupProps }: CarModelProps) {
  // Render with whatever is cached (building it on first use); the mount effect then takes the
  // reference and swaps in a fresh build if the cache was disposed between render and commit.
  const [geo, setGeo] = useState(peekCarGeometry);
  const mats = useMemo(() => createCarMaterials(paint, quality), []); // eslint-disable-line react-hooks/exhaustive-deps

  const root = useRef<Group>(null!);
  const body = useRef<Group>(null!);
  const wheelRoots = useRef<(Group | null)[]>([null, null, null, null]);
  const spinGroups = useRef<(Group | null)[]>([null, null, null, null]);
  const blurMeshes = useRef<(Mesh | null)[]>([null, null, null, null]);
  const throatMesh = useRef<Mesh>(null);

  // per-wheel animation state (mutable, no allocations per frame)
  const state = useRef({
    spin: [0, 0, 0, 0],
    lastSpin: [0, 0, 0, 0],
    rate: [0, 0, 0, 0],
    rateGiven: [false, false, false, false],
    estimated: [0, 0, 0, 0],
    /** Last physics suspension length per wheel. */
    length: [REST_LENGTH, REST_LENGTH, REST_LENGTH, REST_LENGTH],
    /** How far the visual body attitude lowered each wheel's arch crown (m, + = down). */
    drop: [0, 0, 0, 0],
    euler: new Euler(),
    v: new Vector3(),
    lights: 1,
    brake: 0,
  });

  // take a reference on the shared geometry for this instance's lifetime
  useEffect(() => {
    const g = acquireCarGeometry();
    if (g !== geo) setGeo(g);
    return () => releaseCarGeometry();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => disposeCarMaterials(mats), [mats]);
  useEffect(() => {
    mats.paint.color.set(paint);
  }, [mats, paint]);

  const applyRear = () => {
    const s = state.current;
    const running = LIGHT_LEVELS.rearRunning * s.lights;
    mats.lightRear.emissiveIntensity = running + (LIGHT_LEVELS.rearBrake - running) * s.brake;
  };

  /** Vertical wheel placement from the stored physics length and the current body attitude. */
  const placeWheel = (i: number) => {
    const wr = wheelRoots.current[i];
    if (!wr) return;
    const s = state.current;
    wr.position.y = HARDPOINTS[i][1] - visualSuspensionLength(s.length[i], s.drop[i]);
  };

  useImperativeHandle(
    ref,
    (): CarModelHandle => ({
      get group() {
        return root.current;
      },
      get body() {
        return body.current;
      },
      setWheel(i, steerAngle, spinAngle, suspensionLength, spinRate) {
        const wr = wheelRoots.current[i];
        const sg = spinGroups.current[i];
        if (!wr || !sg) return;
        const s = state.current;
        const left = WHEEL_POSITIONS[i][0] < 0;
        s.length[i] = finiteOr(suspensionLength, s.length[i]);
        placeWheel(i);
        wr.rotation.y = finiteOr(steerAngle, 0) + (left ? Math.PI : 0);
        const spin = finiteOr(spinAngle, s.spin[i]);
        // left wheels are the right-hand geometry turned 180° about Y: spin sign flips
        sg.rotation.x = left ? spin : -spin;
        s.spin[i] = spin;
        const rateOk = spinRate !== undefined && Number.isFinite(spinRate);
        s.rateGiven[i] = rateOk;
        if (rateOk) s.rate[i] = spinRate;
      },
      setBoost(level) {
        const l = clamp01(level);
        // slight non-linearity: a hint of glow quickly, full white-hot only near max thrust
        const k = LIGHT_LEVELS.throatMax * (0.25 * l + 0.75 * l * l);
        mats.throat.color.setScalar(k);
        if (throatMesh.current) throatMesh.current.visible = l > 0.002;
      },
      setVacuum(strength) {
        const v = clamp01(strength);
        mats.vacuum.emissiveIntensity = LIGHT_LEVELS.vacuumIdle + (LIGHT_LEVELS.vacuumMax - LIGHT_LEVELS.vacuumIdle) * v;
      },
      setBrake(level) {
        state.current.brake = clamp01(level);
        applyRear();
      },
      setLights(on) {
        const level = typeof on === 'number' ? (on > 0 ? on : 0) : on ? 1 : 0;
        state.current.lights = level;
        mats.lightFront.emissiveIntensity = LIGHT_LEVELS.front * level;
        applyRear();
      },
      setBodyAttitude(pitch, roll, heave = 0) {
        const s = state.current;
        const b = body.current;
        if (!b) return;
        s.euler.set(finiteOr(pitch, 0), 0, finiteOr(roll, 0), 'XZY');
        b.quaternion.setFromEuler(s.euler);
        // rotate about PIVOT: p' = R (p - pivot) + pivot  =>  translation = pivot - R pivot
        s.v.copy(PIVOT).applyQuaternion(b.quaternion);
        b.position.set(PIVOT.x - s.v.x, PIVOT.y - s.v.y + finiteOr(heave, 0), PIVOT.z - s.v.z);
        // arch crown displacement above each wheel, then re-place the wheels against it
        for (let i = 0; i < 4; i++) {
          const p = WHEEL_POSITIONS[i];
          s.v.set(p[0], ARCH_CROWN_Y, p[2]).applyQuaternion(b.quaternion).add(b.position);
          s.drop[i] = ARCH_CROWN_Y - s.v.y;
          placeWheel(i);
        }
      },
    }),
    [mats], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // anti-strobe blur: fade a dish over the spokes as wheel speed rises
  useFrame((_, delta) => {
    const s = state.current;
    const dt = Math.max(1e-4, Math.min(0.1, delta));
    for (let i = 0; i < 4; i++) {
      let rate: number;
      if (s.rateGiven[i]) {
        rate = s.rate[i];
      } else {
        const inst = (s.spin[i] - s.lastSpin[i]) / dt;
        s.estimated[i] += (inst - s.estimated[i]) * Math.min(1, dt * 12);
        rate = s.estimated[i];
      }
      s.lastSpin[i] = s.spin[i];
      const blur = smooth01(BLUR_START, BLUR_FULL, Math.abs(rate));
      const m = mats.blur[i];
      m.opacity = 0.93 * blur;
      const mesh = blurMeshes.current[i];
      if (mesh) mesh.visible = blur > 0.004;
    }
  });

  const cast = shadows;
  const recv = shadows;

  return (
    <group ref={root} name="roadster-car" {...groupProps}>
      <group ref={body}>
        <mesh geometry={geo.paint} material={mats.paint} castShadow={cast} receiveShadow={recv} />
        <mesh geometry={geo.trim} material={mats.trim} castShadow={cast} receiveShadow={recv} />
        <mesh geometry={geo.glass} material={mats.glass} castShadow={cast} receiveShadow={recv} />
        <mesh geometry={geo.titanium} material={mats.titanium} castShadow={cast} receiveShadow={recv} />
        <mesh geometry={geo.lightFront} material={mats.lightFront} />
        <mesh geometry={geo.lightRear} material={mats.lightRear} />
        <mesh geometry={geo.vacuum} material={mats.vacuum} />
        <mesh ref={throatMesh} geometry={geo.throat} material={mats.throat} visible={false} renderOrder={2} />
      </group>
      {WHEEL_POSITIONS.map((p, i) => {
        const left = p[0] < 0;
        const set = i < 2 ? geo.wheelFront : geo.wheelRear;
        // caliper: trailing side of the disc, slightly above the axle
        const caliperAngle = (i < 2 ? 1 : -1) * (left ? -1 : 1) * 1.05;
        return (
          <group
            key={i}
            ref={(g) => {
              wheelRoots.current[i] = g;
            }}
            position={[p[0], p[1], p[2]]}
            rotation={[0, left ? Math.PI : 0, 0]}
          >
            <group
              ref={(g) => {
                spinGroups.current[i] = g;
              }}
            >
              <mesh geometry={set.tire} material={mats.tire} castShadow={cast} receiveShadow={recv} />
              <mesh geometry={set.rim} material={mats.rim} castShadow={cast} receiveShadow={recv} />
              <mesh
                ref={(m) => {
                  blurMeshes.current[i] = m;
                }}
                geometry={set.blur}
                material={mats.blur[i]}
                visible={false}
                renderOrder={1}
              />
            </group>
            <mesh geometry={set.caliper} material={mats.titanium} rotation={[caliperAngle, 0, 0]} castShadow={cast} />
          </group>
        );
      })}
    </group>
  );
}
