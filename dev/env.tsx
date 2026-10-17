/**
 * Environment / lighting / post sandbox.
 *
 *   /dev/env.html?theme=morning|canyon|night|title&view=chase|wide|low|down|sun|title
 *
 * Extra params:
 *   t=2.0          freeze the mock timeline at t seconds (ignored with run=1)
 *   run=1          let the mock run (car drives, jumps, flips, boosts)
 *   q=high         quality preset (low | medium | high)
 *   fx=1           force 290 km/h + full boost (SpeedFX / heat shimmer check)
 *   post=0         no PostFX (renderer ACES instead)
 *   cam=x,y,z&look=x,y,z   free camera;  a=0.55  title orbit angle (view=title)
 *   parts=ao:0,bloom:0,screenFx:0,smaa:1,shadows:0,cloudSea:0,clouds:0,sky:0,landscape:0,world:0,post:0
 *   zoff=-3000     shift the reference scene + mock car along Z (far-travel / no-edges checks)
 *   view=back      look back along +Z (also honors zoff)
 *   sky=0 sun=0 fog=0 env=0 sea=0 clouds=0 land=0     (World part toggles)
 *   set=exposure:0.9,sky.zenith:%23305a9a              theme overrides for art iteration
 *   perf=1         GPU timer probe (window.__perf());  perf=ab[&bench=post]: in-page A/B (window.__ab)
 *   strict=1       wrap in React StrictMode (as the production root does)
 * Runtime hooks: window.__env.setTheme(id) / setQuality(level) / setParts({...});
 *   window.__envStats() → renderer memory / programs, reflection-map bake count, shadow map type.
 */
import { createRoot } from 'react-dom/client';
import { useFrame, useThree } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { Color, Group, MeshBasicMaterial, PMREMGenerator, Vector3, type PerspectiveCamera } from 'three';
import '@/styles/base.css';
import { QUALITY_PRESETS } from '@/config/quality';
import { CAMERA_PRIORITY, runtime } from '@/game/runtime';
import type { QualityLevel, ThemeId } from '@/game/types';
import { NOZZLES, VEHICLE, WHEEL_POSITIONS } from '@/game/vehicleSpec';
import { DevCanvas } from '@/dev/DevCanvas';
import { useMockRuntime } from '@/dev/mockRuntime';
import { PALETTE } from '@/render/palette';
import { World, getTheme, sunDirection } from '@/render/env';
import { PostFX } from '@/render/post';

const params = new URLSearchParams(location.search);
const theme = (params.get('theme') ?? 'morning') as ThemeId;
const view = params.get('view') ?? 'chase';
const run = params.get('run') === '1';
const freezeAt = run ? undefined : Number(params.get('t') ?? 2.0);
const qualityLevel = (params.get('q') ?? 'high') as QualityLevel;
const quality = QUALITY_PRESETS[qualityLevel] ?? QUALITY_PRESETS.high;
const forceFx = params.get('fx') === '1';
/** zoff=-3000: shifts the reference scene and the mock car along Z (far-travel checks: no sky / cloud / terrain edges). */
const zOffset = Number(params.get('zoff') ?? 0) || 0;
const on = (k: string) => params.get(k) !== '0';
runtime.quality = quality;

/**
 * Sandbox-only theme overrides for quick art iteration, e.g.
 *   set=exposure:0.9,grade.look.saturation:1.3,sky.zenith:%23305a9a
 */
function applyOverrides() {
  const spec = params.get('set');
  if (!spec) return;
  const root = getTheme(theme) as unknown as Record<string, unknown>;
  for (const pair of spec.split(',')) {
    const [path, raw] = pair.split(':');
    if (!path || raw === undefined) continue;
    const keys = path.split('.');
    let obj = root;
    for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]] as Record<string, unknown>;
    const last = keys[keys.length - 1];
    const num = Number(raw);
    obj[last] = raw.startsWith('#') || Number.isNaN(num) ? raw : num;
  }
}
applyOverrides();

/* ------------------------------------------------------------------ */
/* Reference architecture                                              */
/* ------------------------------------------------------------------ */

const CONCRETE = PALETTE.concrete;
const CONCRETE_DARK = PALETTE.concreteDark;

function Block({
  pos,
  size,
  color = CONCRETE,
  rough = 0.82,
  metal = 0,
  rot,
}: {
  pos: [number, number, number];
  size: [number, number, number];
  color?: string;
  rough?: number;
  metal?: number;
  rot?: [number, number, number];
}) {
  return (
    <mesh position={pos} rotation={rot} castShadow receiveShadow>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} roughness={rough} metalness={metal} />
    </mesh>
  );
}

/** Emissive strip (LED / edge light). */
function Strip({ pos, size, color, intensity, rot }: { pos: [number, number, number]; size: [number, number, number]; color: string; intensity: number; rot?: [number, number, number] }) {
  const c = useMemo(() => new Color(color).multiplyScalar(intensity), [color, intensity]);
  return (
    <mesh position={pos} rotation={rot}>
      <boxGeometry args={size} />
      <meshBasicMaterial color={c} toneMapped={false} />
    </mesh>
  );
}

function Floodlight({ pos, aim, intensity }: { pos: [number, number, number]; aim: [number, number, number]; intensity: number }) {
  const target = useMemo(() => {
    const g = new Group();
    g.position.set(...aim);
    return g;
  }, [aim]);
  const head = useMemo(() => new Color('#f4f7ff').multiplyScalar(6), []);
  return (
    <group>
      {/* pole ends under the lamp head (y = pos.y - 0.5) instead of poking through it */}
      <mesh position={[pos[0], pos[1] / 2 - 2.25, pos[2]]} castShadow>
        <boxGeometry args={[0.6, pos[1] + 3.5, 0.6]} />
        <meshStandardMaterial color={PALETTE.titanium400} metalness={0.9} roughness={0.35} />
      </mesh>
      <mesh position={pos}>
        <boxGeometry args={[2.4, 1.0, 0.5]} />
        <meshBasicMaterial color={head} toneMapped={false} />
      </mesh>
      <primitive object={target} />
      <spotLight position={pos} target={target} angle={0.42} penumbra={0.75} intensity={intensity} distance={120} decay={2} color="#eef3ff" />
    </group>
  );
}

function ReferenceScene({ night }: { night: boolean }) {
  const led = night ? 1 : 0.55;
  return (
    <group>
      {/* runway deck (top at y = 0) */}
      <Block pos={[0, -1, -300]} size={[30, 2, 720]} color={PALETTE.asphalt} rough={0.9} />
      {/* lane lines */}
      <Strip pos={[-13.6, 0.011, -300]} size={[0.25, 0.02, 720]} color="#f1ede6" intensity={0.9} />
      <Strip pos={[13.6, 0.011, -300]} size={[0.25, 0.02, 720]} color="#f1ede6" intensity={0.9} />
      {Array.from({ length: 36 }, (_, i) => (
        <Strip key={i} pos={[0, 0.011, 40 - i * 20]} size={[0.25, 0.02, 9]} color="#f1ede6" intensity={0.9} />
      ))}
      {/* cyan edge lights */}
      <Strip pos={[-15.05, -0.15, -300]} size={[0.1, 0.12, 720]} color={PALETTE.cyan} intensity={3.4 * led} />
      <Strip pos={[15.05, -0.15, -300]} size={[0.1, 0.12, 720]} color={PALETTE.cyan} intensity={3.4 * led} />
      {/* support pylons diving into the cloud sea */}
      {Array.from({ length: 6 }, (_, i) => (
        <Block key={i} pos={[0, -132, 20 - i * 130]} size={[7, 260, 7]} color={CONCRETE_DARK} />
      ))}

      {/* monolith platforms at various heights */}
      <Block pos={[-52, 2, -70]} size={[34, 20, 44]} />
      <Block pos={[-52, -40, -70]} size={[10, 64, 10]} color={CONCRETE_DARK} />
      <Block pos={[58, -24, -130]} size={[44, 16, 56]} />
      <Block pos={[58, -110, -130]} size={[12, 156, 12]} color={CONCRETE_DARK} />
      <Block pos={[-78, 23, -270]} size={[52, 4, 84]} color={PALETTE.warmWhite2} rough={0.6} />
      <Block pos={[-78, -90, -270]} size={[9, 222, 9]} color={CONCRETE_DARK} />
      {/* ramp from the runway up to the raised deck */}
      <Block pos={[-36, 11, -270]} size={[16, 1.2, 50]} rot={[0, Math.PI / 2, 0.47]} color={CONCRETE} />
      {/* kicker on the runway */}
      <Block pos={[0, 2.2, -210]} size={[16, 1, 22]} rot={[0.27, 0, 0]} color={PALETTE.concrete} />
      <Strip pos={[-8.05, 2.25, -210]} size={[0.1, 0.12, 22]} rot={[0.27, 0, 0]} color={PALETTE.red} intensity={5 * led} />
      <Strip pos={[8.05, 2.25, -210]} size={[0.1, 0.12, 22]} rot={[0.27, 0, 0]} color={PALETTE.red} intensity={5 * led} />
      {/* tall titanium tower (long shadows) */}
      <Block pos={[34, -40, -300]} size={[8, 200, 8]} color={PALETTE.titanium300} rough={0.35} metal={0.9} />
      <Block pos={[22, 58, -300]} size={[32, 2, 3]} color={PALETTE.titanium300} rough={0.35} metal={0.9} />

      {/* judge objects: chrome sphere + white car-sized rounded box */}
      <mesh position={[-6.5, 1.6, -16]} castShadow receiveShadow>
        <sphereGeometry args={[1.6, 64, 32]} />
        <meshStandardMaterial color="#ffffff" metalness={1} roughness={0.04} />
      </mesh>
      <RoundedBox args={[VEHICLE.width, 1.0, VEHICLE.length]} radius={0.3} smoothness={4} position={[6, 0.5, -14]} rotation-y={0.5} castShadow receiveShadow>
        <meshPhysicalMaterial color={PALETTE.paint} roughness={0.3} metalness={0.1} clearcoat={1} clearcoatRoughness={0.05} />
      </RoundedBox>

      {night && (
        <>
          <Floodlight pos={[-17, 16, -30]} aim={[0, 0, -8]} intensity={2600} />
          <Floodlight pos={[17, 16, -50]} aim={[0, 0, -30]} intensity={2600} />
          <Floodlight pos={[-17, 16, -190]} aim={[0, 0, -205]} intensity={2600} />
        </>
      )}
    </group>
  );
}

/** Car stand-in driven by the mock runtime (the sun follows it). */
function CarProxy() {
  const g = useRef<Group>(null);
  const nozzle = useMemo(() => new MeshBasicMaterial({ color: new Color(PALETTE.orange), toneMapped: false }), []);
  const base = useMemo(() => new Color(PALETTE.orange), []);
  useFrame(() => {
    const grp = g.current;
    if (!grp) return;
    grp.position.copy(runtime.frame.position);
    grp.quaternion.copy(runtime.frame.quaternion);
    const b = runtime.frame.snapshot.vehicle.boostLevel;
    nozzle.color.copy(base).multiplyScalar(0.4 + b * 9);
  });
  return (
    <group ref={g}>
      <RoundedBox args={[VEHICLE.width, 0.62, VEHICLE.length]} radius={0.26} smoothness={4} position={[0, 0.07, 0]} castShadow receiveShadow>
        <meshPhysicalMaterial color={PALETTE.paint} roughness={0.28} metalness={0.15} clearcoat={1} clearcoatRoughness={0.05} />
      </RoundedBox>
      <RoundedBox args={[1.32, 0.46, 2.1]} radius={0.2} smoothness={4} position={[0, 0.55, 0.2]} castShadow>
        <meshPhysicalMaterial color={PALETTE.glass} roughness={0.06} metalness={0.5} clearcoat={1} />
      </RoundedBox>
      {WHEEL_POSITIONS.map(([x, y, z], i) => (
        <mesh key={i} position={[x, y, z]} rotation-z={Math.PI / 2} castShadow>
          <cylinderGeometry args={[VEHICLE.wheelRadius, VEHICLE.wheelRadius, 0.3, 28]} />
          <meshStandardMaterial color="#141619" roughness={0.75} />
        </mesh>
      ))}
      {NOZZLES.map((n, i) => (
        <mesh key={i} position={[n.position[0], n.position[1], n.position[2] + 0.01]} material={nozzle}>
          <circleGeometry args={[n.radius, 24]} />
        </mesh>
      ))}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Cameras                                                              */
/* ------------------------------------------------------------------ */

const _t = new Vector3();
const _f = new Vector3();
const _p = new Vector3();

const camParam = params.get('cam')?.split(',').map(Number);
const lookParam = params.get('look')?.split(',').map(Number);
const orbitAngle = Number(params.get('a') ?? 0.55);

function SandboxCamera() {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const sun = useMemo(() => sunDirection(theme), []);
  useFrame((state) => {
    const pos = runtime.frame.position;
    if (camParam && camParam.length === 3) {
      camera.position.set(camParam[0], camParam[1], camParam[2]);
      if (lookParam && lookParam.length === 3) camera.lookAt(lookParam[0], lookParam[1], lookParam[2]);
      return;
    }
    if (view === 'title') {
      // mirrors the integration TitleScene framing: hero car, slow orbit, fov 38
      const a = orbitAngle + (run ? state.clock.elapsedTime * 0.045 : 0);
      camera.position.set(pos.x + Math.cos(a) * 8.2, pos.y + 1.35, pos.z + Math.sin(a) * 8.2);
      camera.lookAt(pos.x, pos.y + 0.15, pos.z);
      if (camera.fov !== 38) {
        camera.fov = 38;
        camera.updateProjectionMatrix();
      }
      return;
    }
    if (view === 'chase') {
      const v = runtime.frame.snapshot.vehicle.velocity;
      _f.set(v.x, 0, v.z);
      if (_f.lengthSq() < 0.01) _f.set(0, 0, -1);
      _f.normalize();
      _p.copy(pos).addScaledVector(_f, -7.6);
      _p.y = pos.y + 2.25;
      camera.position.copy(_p);
      _t.copy(pos).addScaledVector(_f, 5).setY(pos.y + 0.7);
      camera.lookAt(_t);
    } else if (view === 'wide') {
      camera.position.set(78, 34, 58 + zOffset);
      camera.lookAt(-12, -16, -170 + zOffset);
    } else if (view === 'back') {
      // looking back along +Z (the way the level came from)
      camera.position.set(-20, 26, -120 + zOffset);
      camera.lookAt(10, -10, 200 + zOffset);
    } else if (view === 'low') {
      camera.position.set(9, 1.3, 6 + zOffset);
      camera.lookAt(-4, 2.2, -40 + zOffset);
    } else if (view === 'down') {
      camera.position.set(-24, 30, 30 + zOffset);
      camera.lookAt(-140, -170, -260 + zOffset);
    } else if (view === 'sun') {
      camera.position.set(0, 3, 12 + zOffset);
      _t.copy(camera.position).addScaledVector(sun, 100);
      _t.y = Math.max(_t.y, camera.position.y + 4);
      camera.lookAt(_t);
    }
  }, CAMERA_PRIORITY);
  return null;
}

/** Sandbox-only: forces high speed + boost into the mock snapshot (the mock tops out at 162 km/h). */
function FxOverride() {
  useFrame(() => {
    if (zOffset !== 0) runtime.frame.position.z += zOffset;
    if (!forceFx) return;
    const v = runtime.frame.snapshot.vehicle;
    v.speed = 80;
    v.forwardSpeed = 80;
    v.velocity.set(0, 0, -80);
    v.boostLevel = 1;
    v.boosting = true;
  }, -99);
  return null;
}

/** Counts reflection-environment bakes (PMREM from scene) — must only change on theme / env size changes. */
let pmremBakes = 0;
const fromSceneImpl = PMREMGenerator.prototype.fromScene;
PMREMGenerator.prototype.fromScene = function (...args: Parameters<typeof fromSceneImpl>) {
  pmremBakes++;
  return fromSceneImpl.apply(this, args);
};

/** Exposes renderer stats on `window.__env.stats()` (GPU resource leak checks across theme / quality switches). */
function StatsProbe() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const w = window as unknown as { __envStats: () => unknown };
    w.__envStats = () => ({
      geometries: gl.info.memory.geometries,
      textures: gl.info.memory.textures,
      programs: gl.info.programs?.length ?? -1,
      calls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      pmremBakes,
      envUuid: scene.environment?.uuid ?? null,
      shadowType: gl.shadowMap.type,
    });
  }, [gl, scene]);
  return null;
}

/**
 * GPU frame time via EXT_disjoint_timer_query_webgl2 (perf=1): brackets everything rendered between
 * the runtime tick (prio -1000) and after the composer (prio 2). Results on window.__perf.
 */
function PerfProbe() {
  const gl = useThree((s) => s.gl);
  const st = useMemo(() => ({ pending: [] as WebGLQuery[], samples: [] as number[], active: null as WebGLQuery | null }), []);
  const ctx = gl.getContext() as WebGL2RenderingContext;
  const ext = useMemo(() => ctx.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number } | null, [ctx]);
  useEffect(() => {
    (window as unknown as { __perf: () => unknown }).__perf = () => {
      const a = st.samples.slice(-45).sort((x, y) => x - y);
      if (!a.length) return { ext: !!ext, n: 0 };
      return { ext: !!ext, n: a.length, median: +a[a.length >> 1].toFixed(2), p90: +a[Math.floor(a.length * 0.9)].toFixed(2) };
    };
  }, [st, ext]);
  useFrame(() => {
    if (!ext) return;
    // collect finished queries
    for (let i = st.pending.length - 1; i >= 0; i--) {
      const q = st.pending[i];
      if (ctx.getQueryParameter(q, ctx.QUERY_RESULT_AVAILABLE)) {
        st.samples.push(ctx.getQueryParameter(q, ctx.QUERY_RESULT) / 1e6);
        ctx.deleteQuery(q);
        st.pending.splice(i, 1);
      }
    }
    const q = ctx.createQuery()!;
    ctx.beginQuery(ext.TIME_ELAPSED_EXT, q);
    st.active = q;
  }, -1000);
  useFrame(() => {
    if (!ext || !st.active) return;
    ctx.endQuery(ext.TIME_ELAPSED_EXT);
    st.pending.push(st.active);
    st.active = null;
  }, 2);
  return null;
}

function Mock() {
  useMockRuntime({ freezeAt });
  return null;
}

/** Exposes `window.__env.setTheme(id)` / `setQuality(level)` for transition tests (scripts/shot.mjs --eval). */
function useSandboxControls() {
  const [th, setTh] = useState<ThemeId>(theme);
  const [ql, setQl] = useState<QualityLevel>(qualityLevel);
  const [parts, setParts] = useState<Record<string, boolean>>(() => {
    // parts=ao:0,bloom:0,screenFx:0,smaa:1,shadows:0,cloudSea:0 ...
    const out: Record<string, boolean> = {};
    for (const kv of (params.get('parts') ?? '').split(',')) {
      const [k, v] = kv.split(':');
      if (k) out[k] = v === '1';
    }
    return out;
  });
  useAbBench(setParts);
  useEffect(() => {
    (window as unknown as { __env: unknown }).__env = {
      setTheme: (id: ThemeId) => setTh(id),
      setQuality: (q: QualityLevel) => setQl(q),
      setParts: (p: Record<string, boolean>) => setParts(p),
      info: () => ({ theme: th, quality: ql }),
    };
  }, [th, ql]);
  const base = QUALITY_PRESETS[ql] ?? quality;
  const q = useMemo(
    () => ({
      ...base,
      ao: parts.ao ?? base.ao,
      bloom: parts.bloom ?? base.bloom,
      screenFx: parts.screenFx ?? base.screenFx,
      shadows: parts.shadows ?? base.shadows,
      msaaSamples: parts.smaa ? 0 : base.msaaSamples,
    }),
    [base, parts],
  );
  return { th, q, parts };
}

const part = (parts: Record<string, boolean>, k: string, urlKey: string) => (k in parts ? parts[k] : on(urlKey));

/** perf=ab: interleaved A/B GPU timing of the env parts, run in-page; result on window.__ab. */
function useAbBench(setParts: (p: Record<string, boolean>) => void) {
  useEffect(() => {
    if (params.get('perf') !== 'ab') return;
    let cancelled = false;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const configs: Record<string, Record<string, boolean>> =
      params.get('bench') === 'post'
        ? {
            all: {},
            noAO: { ao: false },
            noBloom: { bloom: false },
            noScreenFx: { screenFx: false },
            smaa: { smaa: true },
            noShadows: { shadows: false },
          }
        : {
            all: {},
            noSea: { cloudSea: false },
            noClouds: { clouds: false },
            noSky: { sky: false },
            noLand: { landscape: false },
            none: { cloudSea: false, clouds: false, sky: false, landscape: false },
          };
    (async () => {
      await sleep(1500);
      const res: Record<string, number[]> = {};
      const rounds = params.get("bench") === "post" ? 2 : 3;
      for (let round = 0; round < rounds && !cancelled; round++) {
        for (const [k, p] of Object.entries(configs)) {
          setParts(p);
          await sleep(params.get("bench") === "post" ? 2200 : 900);
          const r = (window as unknown as { __perf: () => { median: number } }).__perf();
          (res[k] ||= []).push(r.median);
        }
      }
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(res)) out[k] = +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2);
      (window as unknown as { __ab: unknown }).__ab = out;
      setParts({});
    })();
    return () => {
      cancelled = true;
    };
  }, [setParts]);
}

function App() {
  const { th, q, parts } = useSandboxControls();
  return (
    <DevCanvas orbit={false} camera={{ position: [6, 3, 8], fov: 62 }} dpr={quality.dpr} toneMapped={params.get('post') === '0'}>
      <Mock />
      {(params.get('perf') === '1' || params.get('perf') === 'ab') && <PerfProbe />}
      <FxOverride />
      <SandboxCamera />
      {part(parts, 'world', 'world') && (
        <World
          theme={th}
          quality={q}
          sky={part(parts, 'sky', 'sky')}
          sun={part(parts, 'sun', 'sun')}
          fog={part(parts, 'fog', 'fog')}
          environment={part(parts, 'environment', 'env')}
          cloudSea={part(parts, 'cloudSea', 'sea')}
          clouds={part(parts, 'clouds', 'clouds')}
          landscape={part(parts, 'landscape', 'land')}
        />
      )}
      <group position={[0, 0, zOffset]}>
        <ReferenceScene night={th === 'night'} />
      </group>
      <CarProxy />
      <StatsProbe />
      {params.get('post') !== '0' && part(parts, 'post', 'postfx') && <PostFX theme={th} quality={q} />}
    </DevCanvas>
  );
}

// strict=1 mirrors the production root (React StrictMode double-invokes effects)
createRoot(document.getElementById('root')!).render(
  params.get('strict') === '1' ? (
    <StrictMode>
      <App />
    </StrictMode>
  ) : (
    <App />
  ),
);
