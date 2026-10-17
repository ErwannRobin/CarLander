/**
 * Car sandbox — http://127.0.0.1:5173/dev/car.html
 *
 *   ?mode=showroom (default)  graphite studio, reflective floor, lightformer strips, slow turntable
 *        &view=front|side|rear|top|wheel|threequarter|rear34|under|low  fixed camera (no turntable)
 *              close-ups: nose|taillight|nozzle|archfront|archrear|canopy|tailcorner|mirror
 *        &cam=x,y,z&look=x,y,z&fov=deg   custom fixed camera (chassis space, floor at y = 0)
 *        &boost=0..1 &vacuum=0..1 &brake=0..1 &lights=0|1 &spin=<rad/s> &steer=<rad> &susp=<m> &paint=<hex>
 *        &car=showroom|model (default: ShowroomCar on the turntable, CarModel for fixed views)
 *        &bare=1   no post / floor / shadows: renderer.info then counts exactly the car's main pass
 *        &grade=title|morning|canyon|night   use the game's FilmGrade + that theme's bloom / vignette
 *                  (lazy-imported from the env / post modules only when requested, so the default
 *                  page keeps depending on the car module + foundation only)
 *        &check=clearance   numeric tyre-vs-body clearance sweep (steer x suspension), logged to the
 *                           console and window.__carClearance
 *        &check=lifecycle   mount -> unmount -> (grace period) -> remount a car and record the shared
 *                           geometry cache + GPU geometry count at each step (window.__carLifecycle)
 *   ?mode=drive               mock runtime on a ground plane with a chase camera (&t=<s> freezes)
 *
 * window.__carStats (refreshed every frame) reports the car's own draw calls / shadow casters /
 * triangles (visible meshes) and the renderer totals of the previous frame across every pass.
 */
import { createRoot } from 'react-dom/client';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Environment, Lightformer, MeshReflectorMaterial, OrbitControls } from '@react-three/drei';
import { Bloom, EffectComposer, ToneMapping, Vignette } from '@react-three/postprocessing';
import { BlendFunction, ToneMappingMode } from 'postprocessing';
import { lazy, StrictMode, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  BackSide,
  type BufferGeometry,
  CanvasTexture,
  type DirectionalLight,
  type Group,
  HalfFloatType,
  type Mesh,
  type Object3D,
  type PerspectiveCamera,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { CAMERA_PRIORITY, runtime } from '@/game/runtime';
import { TUNING } from '@/game/tuning';
import type { ThemeId } from '@/game/types';
import { HARDPOINTS, VEHICLE, WHEEL_POSITIONS } from '@/game/vehicleSpec';
import { MockRuntimeDriver } from '@/dev/mockRuntime';
import { PALETTE } from '@/render/palette';
import { Car, CarModel, ShowroomCar, visualSuspensionLength, type CarModelHandle } from '@/render/car';
import { carGeometryStatus, peekCarGeometry } from '@/render/car/carAssets';
import { archAt, lipInset, lipY, outerCurve, sectionAt, tailInset } from '@/render/car/geometry/bodySurface';
import '@/styles/base.css';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') ?? 'showroom';
const num = (k: string, d: number) => (params.has(k) ? Number(params.get(k)) : d);
const vec3Param = (k: string): [number, number, number] | null => {
  const a = (params.get(k) ?? '').split(',').map(Number);
  return a.length === 3 && a.every(Number.isFinite) ? [a[0], a[1], a[2]] : null;
};
const customCam = vec3Param('cam');
const customLook = vec3Param('look') ?? [0, 0.45, 0];
/** Fixed camera name ('custom' when &cam= is given); null = turntable with orbit controls. */
const view = params.get('view') ?? (customCam ? 'custom' : null);
const bare = params.get('bare') === '1';
const gradeTheme = params.get('grade') as ThemeId | null;
const RIDE = -VEHICLE.groundY;
/** Default turntable (no fixed view) or &car=showroom uses <ShowroomCar/>; fixed views use <CarModel/>. */
const useShowroomCar = params.get('car') === 'showroom' || (!view && params.get('car') !== 'model');

const VIEWS: Record<string, { pos: [number, number, number]; target: [number, number, number]; fov: number }> = {
  front: { pos: [0, 0.78, -9.2], target: [0, 0.52, 0], fov: 25 },
  side: { pos: [11.5, 0.62, 0], target: [0, 0.52, 0], fov: 25 },
  rear: { pos: [0, 0.95, 9.2], target: [0, 0.5, 0], fov: 25 },
  top: { pos: [0, 13.5, 0.001], target: [0, 0, 0], fov: 25 },
  threequarter: { pos: [-6.3, 1.75, -7.1], target: [0, 0.5, 0.1], fov: 27 },
  rear34: { pos: [6.2, 1.9, 7.2], target: [0, 0.45, 0], fov: 27 },
  low: { pos: [-5.6, 0.42, -5.2], target: [0, 0.45, 0.2], fov: 30 },
  wheel: { pos: [-2.55, 0.42, -2.25], target: [-0.86, 0.34, -1.36], fov: 30 },
  taillight: { pos: [1.6, 0.95, 3.6], target: [0.3, 0.75, 2.2], fov: 30 },
  nozzle: { pos: [0.9, 0.42, 3.5], target: [0.34, 0.34, 2.2], fov: 28 },
  nose: { pos: [-1.9, 0.62, -4.3], target: [-0.2, 0.3, -2.0], fov: 32 },
  archfront: { pos: [-2.6, 0.25, -0.2], target: [-0.9, 0.2, -1.2], fov: 30 },
  archrear: { pos: [-2.7, 0.3, 2.9], target: [-0.9, 0.3, 1.5], fov: 30 },
  canopy: { pos: [-2.2, 1.9, -1.6], target: [-0.4, 0.75, -0.3], fov: 32 },
  tailcorner: { pos: [-1.9, 0.9, 3.7], target: [-0.75, 0.55, 2.1], fov: 30 },
  mirror: { pos: [-1.9, 0.95, -1.5], target: [-0.95, 0.8, -0.6], fov: 26 },
  under: { pos: [0.01, -6.5, 0.6], target: [0, RIDE, 0], fov: 32 },
};

type StatsWindow = Window & { __carStats?: object; __carClearance?: object; __carLifecycle?: object; __shotReady?: boolean };

const triCount = (g: BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;

/**
 * Exposes renderer stats for scripts/shot.mjs --eval "JSON.stringify(window.__carStats)".
 * The EffectComposer issues several render() calls per frame and three resets renderer.info on each
 * of them by default, so info.autoReset is turned off and the totals are collected per frame here.
 */
function StatsProbe() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    gl.info.autoReset = false;
    return () => {
      gl.info.autoReset = true;
    };
  }, [gl]);
  useFrame(() => {
    // first callback of the frame: publish what the previous frame rendered, then reset
    let meshes = 0;
    let casters = 0;
    let triangles = 0;
    const car = scene.getObjectByName('roadster-car');
    // CarModel's first child is the body group that carries the visual lean / squat
    const body = car?.children[0];
    car?.traverseVisible((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      meshes++;
      if (m.castShadow) casters++;
      triangles += triCount(m.geometry);
    });
    // status only: peeking would rebuild the shared cache while no car is mounted
    const g = carGeometryStatus();
    (window as StatsWindow).__carStats = {
      carGeometryTriangles: g.stats?.triangles ?? 0,
      buildMs: Math.round(g.stats?.buildMs ?? 0),
      geometryRefs: g.refs,
      carDrawCalls: meshes,
      carShadowCasters: casters,
      carVisibleTriangles: Math.round(triangles),
      frameCallsAllPasses: gl.info.render.calls,
      frameTrianglesAllPasses: gl.info.render.triangles,
      geometries: gl.info.memory.geometries,
      programs: gl.info.programs?.length ?? 0,
      bodyPitchDeg: body ? +((body.rotation.x * 180) / Math.PI).toFixed(3) : 0,
      bodyRollDeg: body ? +((body.rotation.z * 180) / Math.PI).toFixed(3) : 0,
    };
    gl.info.reset();
  }, -1000);
  return null;
}

/* ------------------------------------------------------------------------------------------ */
/* Tyre clearance sweep                                                                        */
/* ------------------------------------------------------------------------------------------ */

interface ClearanceRow {
  wheel: string;
  steer: number;
  length: number;
  /** Max penetration (m, > 0 = intersecting) per body region. */
  tub: number;
  /** Hidden arch liner (the dark wheel-well ceiling). */
  liner: number;
  /** Outer paint skin above the wheel well (hood / fender / deck): a visible poke-through. */
  skin: number;
  fender: number;
  wall: number;
}

/** Paint/lower-body outer half width at (z, y), with the black recess below the lip. */
function bodyHalfWidth(z: number, y: number): number {
  const x = outerCurve(sectionAt(z), tailInset(z)).maxXAtY(y);
  if (!Number.isFinite(x)) return 0;
  return y < lipY(z) ? x - lipInset(z) : x;
}

/**
 * Transforms every tyre vertex like CarModel places the wheel (steer about the wheel centre,
 * visual suspension mapping, left wheels = right geometry turned PI about Y) and measures how far
 * it penetrates the body volume: the inner tub wall, the sloped arch liner, the fender above the
 * arch circle, and the body beyond the U-shaped arch (fore/aft walls).
 */
function clearanceSweep(): ClearanceRow[] {
  const geo = peekCarGeometry();
  const rows: ClearanceRow[] = [];
  const p = new Vector3();
  const widthCache = new Map<string, number>();
  const skinCache = new Map<string, number>();
  /** Outer surface height (hood / fender / deck) at lateral offset x. */
  const skinY = (z: number, x: number) => {
    const k = `${z.toFixed(3)}:${x.toFixed(3)}`;
    let v = skinCache.get(k);
    if (v === undefined) {
      v = outerCurve(sectionAt(z), tailInset(z)).maxYAtX(x);
      if (!Number.isFinite(v)) v = Infinity;
      skinCache.set(k, v);
    }
    return v;
  };
  const width = (z: number, y: number) => {
    const k = `${z.toFixed(3)}:${y.toFixed(3)}`;
    let w = widthCache.get(k);
    if (w === undefined) {
      w = bodyHalfWidth(z, y);
      widthCache.set(k, w);
    }
    return w;
  };
  const sp = VEHICLE.suspension;
  // bump stop, mid-bump, bump-stop onset, static ride, full droop
  const lengths = [sp.minLength, 0.2, TUNING.suspension.bumpStopStart, sp.hardpointY, sp.restLength];
  for (const i of [0, 1, 2, 3]) {
    const front = i < 2;
    const left = WHEEL_POSITIONS[i][0] < 0;
    const tire = (front ? geo.wheelFront : geo.wheelRear).tire.getAttribute('position');
    const steers = front ? [-0.6, -0.524, 0, 0.524, 0.6] : [0];
    for (const steer of steers) {
      const yaw = steer + (left ? Math.PI : 0);
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      for (const length of lengths) {
        const yc = HARDPOINTS[i][1] - visualSuspensionLength(length);
        const row: ClearanceRow = { wheel: ['FL', 'FR', 'RL', 'RR'][i], steer, length, tub: -1, liner: -1, skin: -1, fender: -1, wall: -1 };
        for (let k = 0; k < tire.count; k++) {
          p.fromBufferAttribute(tire, k);
          // rotation about Y (three.js convention), then translate to the wheel centre
          const x = WHEEL_POSITIONS[i][0] + p.x * c + p.z * s;
          const y = yc + p.y;
          const z = WHEEL_POSITIONS[i][2] - p.x * s + p.z * c;
          const ax = Math.abs(x);
          const sec = sectionAt(z);
          if (y <= sec.yFloor) continue; // below the floor: nothing to hit
          const a = archAt(z);
          if (a.inArch) {
            if (ax < a.tub) {
              // inboard of the tub wall: inside the body unless below the floor
              row.tub = Math.max(row.tub, Math.min(a.tub - ax, y - sec.yFloor));
              continue;
            }
            // outer lip x where the arch circle meets the outer surface
            const xo = width(z, a.top);
            if (ax <= xo) {
              const t = xo > a.tub ? (ax - a.tub) / (xo - a.tub) : 1;
              const ceil = a.innerTop + (a.top - a.innerTop) * t;
              row.liner = Math.max(row.liner, y - ceil);
              row.skin = Math.max(row.skin, y - skinY(z, ax));
            } else if (y > a.top) {
              row.fender = Math.max(row.fender, Math.min(y - a.top, width(z, y) - ax));
            }
          } else {
            row.wall = Math.max(row.wall, Math.min(width(z, y) - ax, y - sec.yFloor));
          }
        }
        rows.push(row);
      }
    }
  }
  return rows;
}

function ClearanceCheck() {
  useEffect(() => {
    const t0 = performance.now();
    const rows = clearanceSweep();
    const fmt = (v: number) => (v > 0 ? `+${(v * 1000).toFixed(1)}mm` : 'ok');
    const worst = rows.reduce((m, r) => Math.max(m, r.tub, r.liner, r.skin, r.fender, r.wall), -1);
    console.info(`[car] clearance sweep ${rows.length} poses in ${(performance.now() - t0).toFixed(0)} ms, worst ${fmt(worst)}`);
    console.table(rows.map((r) => ({ ...r, tub: fmt(r.tub), liner: fmt(r.liner), skin: fmt(r.skin), fender: fmt(r.fender), wall: fmt(r.wall) })));
    (window as StatsWindow).__carClearance = { worst, rows };
  }, []);
  return null;
}

/* ------------------------------------------------------------------------------------------ */
/* Geometry lifecycle check                                                                    */
/* ------------------------------------------------------------------------------------------ */

/** Must exceed carAssets' DISPOSE_GRACE_MS (1.5 s). */
const LIFECYCLE_WAIT_MS = 2200;

function LifecycleScene() {
  const gl = useThree((s) => s.gl);
  const [mounted, setMounted] = useState(true);
  useEffect(() => {
    const log: object[] = [];
    const snap = (label: string) => {
      const st = carGeometryStatus();
      log.push({ label, built: st.built, refs: st.refs, gpuGeometries: gl.info.memory.geometries });
    };
    const timers = [
      setTimeout(() => snap('mounted'), 600),
      setTimeout(() => setMounted(false), 700),
      setTimeout(() => snap('unmounted, inside grace period'), 1000),
      setTimeout(() => {
        snap('unmounted, after grace period');
        setMounted(true);
      }, 700 + LIFECYCLE_WAIT_MS),
      setTimeout(() => {
        snap('remounted');
        (window as StatsWindow).__carLifecycle = log;
        console.info('[car] lifecycle', JSON.stringify(log));
        signalReady(0);
      }, 1500 + LIFECYCLE_WAIT_MS),
    ];
    return () => timers.forEach(clearTimeout);
  }, [gl]);
  return (
    <>
      <color attach="background" args={['#101215']} />
      <StudioLights />
      {mounted && <CarModel position={[0, RIDE, 0]} />}
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Showroom                                                                                    */
/* ------------------------------------------------------------------------------------------ */

function signalReady(delayMs = 600) {
  setTimeout(() => ((window as StatsWindow).__shotReady = true), delayMs);
}

function FixedCamera({ name }: { name: string }) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  useEffect(() => {
    const v = customCam ? { pos: customCam, target: customLook, fov: num('fov', 30) } : (VIEWS[name] ?? VIEWS.threequarter);
    camera.position.set(...v.pos);
    camera.fov = v.fov;
    camera.near = 0.02;
    camera.far = 400;
    if (name === 'under') camera.up.set(0, 0, -1);
    camera.lookAt(...v.target);
    camera.updateProjectionMatrix();
  }, [camera, name]);
  return null;
}

function StudioLights() {
  return (
    <Environment resolution={512} frames={1} environmentIntensity={1}>
      <color attach="background" args={['#08090b']} />
      {/* overhead softbox (soft top light) */}
      <Lightformer form="rect" intensity={1.5} position={[0, 7, 0]} rotation-x={Math.PI / 2} scale={[9, 3.2, 1]} />
      {/* long, narrow side strips: crisp shoulder and sill highlights */}
      <Lightformer form="rect" intensity={5} position={[-7, 2.6, 0]} rotation-y={Math.PI / 2} scale={[14, 0.32, 1]} />
      <Lightformer form="rect" intensity={5} position={[7, 2.6, 0]} rotation-y={-Math.PI / 2} scale={[14, 0.32, 1]} />
      <Lightformer form="rect" intensity={1.6} position={[-7, 0.7, 0]} rotation-y={Math.PI / 2} scale={[14, 0.16, 1]} />
      <Lightformer form="rect" intensity={1.6} position={[7, 0.7, 0]} rotation-y={-Math.PI / 2} scale={[14, 0.16, 1]} />
      {/* high rim behind the car + front panel */}
      <Lightformer form="rect" intensity={2.2} position={[0, 4.5, 8]} rotation-x={-Math.PI / 6} rotation-y={Math.PI} scale={[10, 1.2, 1]} />
      <Lightformer form="rect" intensity={1.1} position={[0, 2.5, -9]} scale={[8, 1.4, 1]} />
      {/* warm low fill + restrained cyan accent */}
      <Lightformer form="rect" intensity={0.6} color="#ffd7b0" position={[-5, 0.4, -6]} rotation-y={Math.PI / 5} scale={[5, 0.6, 1]} />
      <Lightformer form="rect" intensity={0.9} color={PALETTE.cyan} position={[6, 0.5, 5]} rotation-y={-Math.PI * 0.75} scale={[4, 0.14, 1]} />
    </Environment>
  );
}

function ShowroomScene() {
  const turntable = useRef<Group>(null!);
  const model = useRef<CarModelHandle>(null);
  const spinRate = num('spin', 0);
  const steer = num('steer', view ? 0 : 0.28);
  const spin = useRef(0);
  useEffect(() => {
    const g = peekCarGeometry();
    console.info(`[car] triangles=${g.stats.triangles} build=${g.stats.buildMs.toFixed(1)}ms`);
    signalReady(900);
  }, []);
  useFrame((_, dt) => {
    if (!view) turntable.current.rotation.y += dt * 0.16;
    const h = model.current;
    if (!h) return;
    spin.current += spinRate * Math.min(dt, 0.05);
    const susp = num('susp', VEHICLE.suspension.hardpointY);
    for (let i = 0; i < 4; i++) h.setWheel(i, i < 2 ? steer : 0, spin.current, susp, spinRate);
    h.setBoost(num('boost', 0));
    h.setVacuum(num('vacuum', 0));
    h.setBrake(num('brake', 0));
    h.setLights(num('lights', 1));
  });
  return (
    <>
      <color attach="background" args={['#101215']} />
      {!bare && <fog attach="fog" args={['#101215', 14, 34]} />}
      <StudioLights />
      {!bare && (
        <directionalLight
          position={[-3.5, 7, -2.5]}
          intensity={1.1}
          castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-bias={-0.0004}
          shadow-normalBias={0.025}
        >
          <orthographicCamera attach="shadow-camera" args={[-4, 4, 4, -4, 0.5, 20]} />
        </directionalLight>
      )}
      <hemisphereLight args={['#c9d4e0', '#0d0f12', 0.12]} />
      <group ref={turntable}>
        {/* both components use the chassis origin: a car resting on the floor sits RIDE above it */}
        {useShowroomCar ? (
          <ShowroomCar position={[0, RIDE, 0]} paint={params.get('paint') ?? undefined} steer={num('steer', 0.3)} />
        ) : (
          <CarModel ref={model} position={[0, RIDE, 0]} paint={params.get('paint') ?? undefined} />
        )}
      </group>
      {!bare && (
        <mesh rotation-x={-Math.PI / 2} receiveShadow>
          <planeGeometry args={[80, 80]} />
          <MeshReflectorMaterial
            resolution={1024}
            blur={[400, 120]}
            mixBlur={1}
            mixStrength={1.6}
            mixContrast={1}
            roughness={0.85}
            depthScale={1.1}
            minDepthThreshold={0.4}
            maxDepthThreshold={1.3}
            color="#1b1e22"
            metalness={0.35}
            mirror={0.55}
          />
        </mesh>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Drive                                                                                       */
/* ------------------------------------------------------------------------------------------ */

/** Procedural asphalt-ish grid so speed reads in drive mode. */
function useGroundTexture() {
  return useMemo(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const g = c.getContext('2d')!;
    g.fillStyle = '#2b2e33';
    g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 3000; i++) {
      const v = 38 + Math.random() * 14;
      g.fillStyle = `rgb(${v},${v + 2},${v + 5})`;
      g.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
    }
    g.fillStyle = '#e6dfd3';
    g.fillRect(250, 0, 12, 200);
    g.fillStyle = '#454b53';
    g.fillRect(0, 0, 512, 3);
    g.fillRect(0, 0, 3, 512);
    const tex = new CanvasTexture(c);
    tex.wrapS = tex.wrapT = RepeatWrapping;
    tex.repeat.set(40, 400);
    tex.colorSpace = SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }, []);
}

const CHASE_OFFSET = new Vector3(-2.4, 2.1, 0);

function ChaseCamera() {
  const camera = useThree((s) => s.camera);
  const st = useRef({ pos: new Vector3(4, 3, 8), look: new Vector3(), off: new Vector3(), fwd: new Vector3(), init: false });
  useFrame((_, dt) => {
    const f = runtime.frame;
    const s = st.current;
    // yaw-only follow so flips do not spin the camera
    s.fwd.set(0, 0, -1).applyQuaternion(f.quaternion);
    s.fwd.y = 0;
    if (s.fwd.lengthSq() < 1e-4) s.fwd.set(0, 0, -1);
    s.fwd.normalize();
    s.off.copy(s.fwd).multiplyScalar(-7.2).add(CHASE_OFFSET);
    const target = s.off.add(f.position);
    const k = s.init ? 1 - Math.exp(-dt * 5) : 1;
    s.pos.lerp(target, k);
    s.look.lerp(f.position, s.init ? 1 - Math.exp(-dt * 10) : 1);
    s.init = true;
    camera.position.copy(s.pos);
    camera.lookAt(s.look.x, s.look.y + 0.4, s.look.z);
  }, CAMERA_PRIORITY);
  return null;
}

function FollowSun() {
  const light = useRef<DirectionalLight>(null!);
  const target = useRef<Object3D>(null!);
  useFrame(() => {
    const p = runtime.frame.position;
    light.current.position.set(p.x - 4, p.y + 9, p.z - 3);
    target.current.position.copy(p);
    light.current.target = target.current;
  });
  return (
    <>
      <directionalLight ref={light} intensity={2.2} color="#fff4e6" castShadow shadow-mapSize={[2048, 2048]} shadow-bias={-0.0004} shadow-normalBias={0.03}>
        <orthographicCamera attach="shadow-camera" args={[-6, 6, 6, -6, 0.5, 40]} />
      </directionalLight>
      <object3D ref={target} />
    </>
  );
}

/** Gradient sky dome rendered into the environment cube (horizon line + zenith for reflections). */
const SKY_VERT = `varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SKY_FRAG = `varying vec3 vDir;
void main() {
  float h = vDir.y;
  vec3 zenith = vec3(0.22, 0.38, 0.62);
  vec3 horizon = vec3(0.86, 0.88, 0.9);
  vec3 ground = vec3(0.16, 0.16, 0.17);
  vec3 c = h > 0.0 ? mix(horizon, zenith, pow(h, 0.45)) : mix(horizon * 0.55, ground, pow(-h, 0.35));
  gl_FragColor = vec4(c * 1.15, 1.0);
}`;

function SkyEnvironment() {
  return (
    <Environment resolution={256} frames={1}>
      <mesh scale={50}>
        <sphereGeometry args={[1, 48, 24]} />
        <shaderMaterial vertexShader={SKY_VERT} fragmentShader={SKY_FRAG} side={BackSide} depthWrite={false} />
      </mesh>
      <Lightformer form="circle" intensity={14} color="#fff4e0" position={[-20, 24, -14]} scale={4} target={[0, 0, 0]} />
    </Environment>
  );
}

function DriveScene() {
  const tex = useGroundTexture();
  useEffect(() => () => tex.dispose(), [tex]);
  const freeze = params.has('t') ? Number(params.get('t')) : undefined;
  useEffect(() => signalReady(1200), []);
  return (
    <>
      <color attach="background" args={['#9fb3c6']} />
      <fog attach="fog" args={['#9fb3c6', 60, 400]} />
      <MockRuntimeDriver freezeAt={freeze} />
      <ChaseCamera />
      <FollowSun />
      <hemisphereLight args={['#dfe8f2', '#3a3f45', 0.45]} />
      <SkyEnvironment />
      <Car />
      <mesh rotation-x={-Math.PI / 2} position={[0, 0, -1980]} receiveShadow>
        <planeGeometry args={[400, 4040]} />
        <meshStandardMaterial map={tex} roughness={0.9} />
      </mesh>
    </>
  );
}

/** Optional parity check against the in-game grade (see &grade=). */
const GameGradeComposer = gradeTheme
  ? lazy(async () => {
      const [{ FilmGrade }, { resolveTheme }] = await Promise.all([import('@/render/post'), import('@/render/env/themes')]);
      const theme = resolveTheme(gradeTheme);
      function GameGrade() {
        return (
          <EffectComposer multisampling={4} frameBufferType={HalfFloatType}>
            <Bloom
              blendFunction={BlendFunction.ADD}
              mipmapBlur
              intensity={theme.bloom.intensity}
              luminanceThreshold={theme.bloom.threshold}
              luminanceSmoothing={theme.bloom.smoothing}
            />
            <Vignette eskil={false} offset={theme.vignette.offset} darkness={theme.vignette.darkness} />
            <FilmGrade theme={theme} />
          </EffectComposer>
        );
      }
      return { default: GameGrade };
    })
  : null;

function Post() {
  if (GameGradeComposer) {
    return (
      <Suspense fallback={null}>
        <GameGradeComposer />
      </Suspense>
    );
  }
  return (
    <EffectComposer multisampling={4}>
      <Bloom mipmapBlur intensity={0.55} luminanceThreshold={1.0} luminanceSmoothing={0.2} />
      <Vignette eskil={false} offset={0.25} darkness={0.55} />
      <ToneMapping mode={ToneMappingMode.AGX} />
    </EffectComposer>
  );
}

function App() {
  const drive = mode === 'drive';
  return (
    <Canvas
      shadows={bare ? false : 'percentage'}
      flat
      dpr={[1, 2]}
      gl={{ antialias: false, stencil: false, powerPreference: 'high-performance' }}
      camera={{ fov: 30, position: [-6.3, 1.75, -7.1], near: 0.05, far: 2000 }}
      style={{ position: 'fixed', inset: 0 }}
    >
      {drive ? <DriveScene /> : params.get('check') === 'lifecycle' ? <LifecycleScene /> : <ShowroomScene />}
      <StatsProbe />
      {params.get('check') === 'clearance' && <ClearanceCheck />}
      {!drive && view && <FixedCamera name={view} />}
      {!drive && !view && <OrbitControls target={[0, 0.5, 0]} makeDefault />}
      {!bare && <Post />}
    </Canvas>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
