/**
 * Title / menu backdrop: the hero car on a floating plinth high above the clouds at golden hour,
 * with a slow cinematic orbit. The car sits right of center to leave room for the wordmark.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { AdditiveBlending, Color, PerspectiveCamera, Vector3 } from 'three';
import type { QualityPreset } from '@/config/quality';
import { runtime } from '@/game/runtime';
import { VEHICLE } from '@/game/vehicleSpec';
import { ShowroomCar } from '@/render/car';
import { World } from '@/render/env';
import { PALETTE } from '@/render/palette';
import { PostFX } from '@/render/post';
import { clampZoom, wheelZoomFactor } from '@/input/touchInput';

const PLINTH_TOP = 0;
const CAR_Y = PLINTH_TOP - VEHICLE.groundY;

/** Orbit speed of the idle camera (rad/s), and how long it waits after the last touch before moving again (s). */
const AUTO_ORBIT = 0.045;
const AUTO_RESUME = 2.5;
const DRAG_YAW_PER_PX = 0.006;
const DRAG_PITCH_PER_PX = 0.004;
/** Camera elevation limits above the car (rad): never under the plinth, never straight down. */
const MIN_ELEV = 0.03;
const MAX_ELEV = 1.4;

const target = new Vector3();
const right = new Vector3();
const fwd = new Vector3();

/** What the player did to the title camera: drag = orbit, pinch / wheel = zoom. */
interface TitleLook {
  yaw: number;
  pitch: number;
  zoom: number;
  /** Seconds since the last touch. */
  idle: number;
  active: boolean;
}

/** Drag / pinch / wheel on the canvas steer the camera around the showroom car. */
function useTitleLook() {
  const gl = useThree((s) => s.gl);
  const look = useRef<TitleLook>({ yaw: 0, pitch: 0, zoom: 1, idle: 0, active: false });

  useEffect(() => {
    const el = gl.domElement;
    const l = look.current;
    const fingers = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    const prevTouchAction = el.style.touchAction;
    el.style.touchAction = 'none'; // no page pan / zoom: the gestures are ours

    const spread = () => {
      const [a, b] = [...fingers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const onDown = (e: PointerEvent) => {
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* pointer already gone */
      }
      fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (fingers.size === 2) pinch = spread();
      l.active = true;
      l.idle = 0;
    };
    const onMove = (e: PointerEvent) => {
      const f = fingers.get(e.pointerId);
      if (!f) return;
      const dx = e.clientX - f.x;
      const dy = e.clientY - f.y;
      f.x = e.clientX;
      f.y = e.clientY;
      l.idle = 0;
      if (fingers.size === 2) {
        const now = spread();
        // fingers apart = closer camera, together = farther
        if (pinch > 0 && now > 1) l.zoom = clampZoom(l.zoom * (pinch / now));
        pinch = now;
      } else if (fingers.size === 1 && Math.abs(dx) + Math.abs(dy) > 0) {
        // like grabbing the car: drag right and it turns right, drag down and the camera rises
        l.yaw += dx * DRAG_YAW_PER_PX;
        l.pitch += dy * DRAG_PITCH_PER_PX;
      }
    };
    const onUp = (e: PointerEvent) => {
      fingers.delete(e.pointerId);
      pinch = 0;
      if (fingers.size === 0) l.active = false;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      l.zoom = clampZoom(l.zoom * wheelZoomFactor(e));
      l.idle = 0;
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('lostpointercapture', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.style.touchAction = prevTouchAction;
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('lostpointercapture', onUp);
      el.removeEventListener('wheel', onWheel);
    };
  }, [gl]);

  return look;
}

function TitleCamera({ variant }: { variant: 'title' | 'menu' }) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const size = useThree((s) => s.size);
  const look = useTitleLook();
  /** Angle of the idle orbit; it stands still while the player is looking around. */
  const auto = useRef(0.55 + (variant === 'menu' ? 0.9 : 0));
  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    const l = look.current;
    const dt = Math.min(0.1, delta);
    l.idle += dt;
    if (!l.active && l.idle > AUTO_RESUME) auto.current += dt * AUTO_ORBIT;
    const portrait = size.height > size.width * 1.1;
    const radius = portrait ? 11.5 : 8.2;
    const y = (portrait ? 3.4 : 1.35) + Math.sin(t * 0.21) * 0.12;
    // base boom from the car, then the player's yaw / pitch / zoom on top of it
    const rel = y - 0.15;
    const elev = Math.min(MAX_ELEV, Math.max(MIN_ELEV, Math.atan2(rel, radius) + l.pitch));
    const len = Math.hypot(radius, rel) * l.zoom;
    const a = auto.current + l.yaw;
    camera.position.set(
      Math.cos(a) * Math.cos(elev) * len,
      CAR_Y + 0.15 + Math.sin(elev) * len,
      Math.sin(a) * Math.cos(elev) * len,
    );
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
