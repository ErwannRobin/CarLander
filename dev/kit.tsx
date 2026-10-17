/**
 * Sandbox: track rendering + architecture kit (src/render/level).
 *
 * http://127.0.0.1:5173/dev/kit.html?view=<name>
 *   day (L1-style track):   overview runway ramp kicker air landing targetClose finish under hints live
 *   night (Tesla crescent): crescent crescentSide climb arena
 *   kit gallery:            kit kitClose styles canyon canyonSide
 *   QA close-ups:           release (driver's view, surface-up camera, RELEASE marking on the inverted
 *                           beam) releaseWorld invert junction targetGraze skywalk
 *                           pylons pylonsBoxes pylonsDecal (separate QA level: steep / wide / banked decks,
 *                           wide-box field variants, finish arch on a box, triggers)
 *                           hintfade (scripted objective timeline -> window.__hint opacities)
 * Extra params:
 *   theme=day|night|canyon  override the view's lighting
 *   cam=x,y,z&at=x,y,z      override the camera of any view
 *   off=level,track,arena,gallery,post   disable parts (debugging)
 *   level=TEST_RAMP|TEST_VACUUM|TEST_FLAT [&cam=x,y,z&at=x,y,z]  render a physics test level instead
 *   churn=N                 mount / unmount <LevelGeometry> N times -> window.__churn renderer memory
 *                           (geometries / textures must return to the same values every run)
 *   led=red:5.2:ff2b3d      LED tint calibration override (color:intensity:hex)
 *   timing                  measure buildLevelGeometry() (window.__buildMs); window.__texMs, window.__stats
 * The lighting / sky / cloud floor here are stand-ins for src/render/env (not imported on purpose);
 * the post chain mirrors production essentials (per-theme bloom threshold + AgX).
 */
import { createRoot } from 'react-dom/client';
import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Environment, Lightformer } from '@react-three/drei';
import { Bloom, EffectComposer, ToneMapping } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import {
  BackSide,
  Box3,
  CanvasTexture,
  Color,
  RepeatWrapping,
  SRGBColorSpace,
  Fog,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type DirectionalLight,
} from 'three';
import '@/styles/base.css';
import { DevCanvas } from '@/dev/DevCanvas';
import { MockRuntimeDriver } from '@/dev/mockRuntime';
import { runtime } from '@/game/runtime';
import { TrackPath, frameAt } from '@/game/track/TrackPath';
import type { LevelDef, PieceDef, TrackFrame, V3, ZoneDef } from '@/game/types';
import {
  Arch,
  Billboard,
  CableStays,
  CanyonWall,
  FacilityBase,
  Floodlight,
  Grandstand,
  LEDStrip,
  LevelGeometry,
  buildLevelGeometry,
  getLevelMaterials,
  LED_TINTS,
  LightRig,
  Monolith,
  Pylon,
  RingGate,
  RockSpire,
  TrussBeam,
  TrussTower,
} from '@/render/level';
import { PALETTE } from '@/render/palette';

/* ------------------------------------------------------------------ */
/* Demo level                                                          */
/* ------------------------------------------------------------------ */

function smooth01(x: number) {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

function makeDemoLevel() {
  const runway = new TrackPath({ position: [0, 0, 60] }).straight(300);
  const kick = TrackPath.fromFrame(runway.end()).straight(24).up(18, 64);
  const lip = kick.end();
  const landStart = new Vector3(lip.position.x, lip.position.y - 13, lip.position.z - 98);
  const landing = new TrackPath({ position: landStart, pitchDeg: -10 }).straight(30).up(10, 120).straight(190);
  const landFlatS = 30 + (10 * Math.PI) / 180 * 120;
  const target = landing.at(landFlatS + 28);
  const finish = landing.at(landing.length - 26);

  const crescent = new TrackPath({ position: [250, 0.06, -30] })
    .straight(60)
    .up(90, 28)
    .straight(18)
    .up(90, 12)
    .straight(50)
    .left(14, 160);

  const pieces: PieceDef[] = [
    { kind: 'ribbon', id: 'runway', frames: runway.frames, width: 26, style: 'runway', edgeLights: 'cyan' },
    {
      kind: 'ribbon',
      id: 'kicker',
      frames: kick.frames,
      width: (s) => 26 + (16 - 26) * smooth01(s / 22),
      style: 'ramp',
      edgeLights: 'orange',
    },
    { kind: 'ribbon', id: 'landing', frames: landing.frames, width: 30, style: 'landing', edgeLights: 'white' },
    // night arena floor: 'runway' on a wide box renders the marking-free dark asphalt apron (field
    // variant), like the dark floor of the reference footage
    { kind: 'box', id: 'arena', center: [250, -2, -110], size: [200, 4, 280], style: 'runway', edgeLights: 'red' },
    { kind: 'box', id: 'gallery', center: [-300, -2, -200], size: [260, 4, 340], style: 'platform', edgeLights: 'cyan' },
    { kind: 'ribbon', id: 'crescent', frames: crescent.frames, width: 14, style: 'adhesive', edgeLights: 'red' },
    // style showcase on the gallery: a railed brushed-metal skywalk and a glass deck
    {
      kind: 'ribbon',
      id: 'skywalk',
      frames: new TrackPath({ position: [-420, 9, -110], yawDeg: -90 }).straight(30).left(30, 40).straight(40).frames,
      width: 10,
      style: 'metal',
      rails: 1.1,
      edgeLights: 'cyan',
      supports: false,
    },
    {
      kind: 'ribbon',
      id: 'glassdeck',
      frames: new TrackPath({ position: [-330, 4, -340], yawDeg: -90 }).straight(50).frames,
      width: 12,
      style: 'glass',
      edgeLights: 'white',
      supports: false,
    },
  ];

  const zoneAt = (f: TrackFrame, id: string, purpose: ZoneDef['purpose'], half: V3, lift: number): ZoneDef => ({
    id,
    purpose,
    center: [f.position.x, f.position.y + lift, f.position.z],
    halfSize: half,
  });
  const gateCenter = lip.position.clone().lerp(landStart, 0.5).add(new Vector3(0, 9, 0));
  // RELEASE trigger near the end of the inverted beam, authored like the physics test level
  // (yaw-only rotation, center 1.5 m below the beam on its drive side, wider than the deck)
  const release = crescent.at(crescent.length - 12);
  const releaseYaw = (Math.atan2(-release.forward.x, -release.forward.z) * 180) / Math.PI;
  const releaseCenter = release.position.clone().addScaledVector(release.up, 1.5);
  const zones: ZoneDef[] = [
    zoneAt(target, 'target', 'target', [13, 3, 13], 1.5),
    zoneAt(finish, 'finish', 'finish', [15, 4, 18], 2),
    { id: 'gate', purpose: 'gate', center: [gateCenter.x, gateCenter.y, gateCenter.z], halfSize: [10, 10, 1] },
    {
      id: 'release',
      purpose: 'trigger',
      center: [releaseCenter.x, releaseCenter.y, releaseCenter.z],
      halfSize: [9, 4, 10],
      rotationDeg: [0, releaseYaw, 0],
      label: 'RELEASE',
      visible: true,
    },
  ];

  const level: LevelDef = {
    id: 1,
    name: 'KIT DEMO',
    subtitle: 'Track rendering sandbox',
    description: '',
    theme: 'morning',
    spawn: { position: [0, 0.4, 40], yawDeg: 0, speed: 10 },
    killY: -80,
    vacuumEnabled: true,
    fuel: { capacity: 4, regenPerSec: 0.5, regenDelay: 1, start: 1 },
    pieces,
    zones,
    objectives: [],
    floatingHints: [
      {
        id: 'h-thrust',
        position: [0, lip.position.y + 9, lip.position.z + 40],
        text: 'FIRE THRUSTERS',
        hint: { keys: ['SPACE'], label: 'Hold' },
        objectiveId: 'demo',
      },
      {
        id: 'h-accel',
        position: [-9, 6, -20],
        text: 'ACCELERATE',
        hint: { keys: ['W'], label: 'Throttle' },
      },
      {
        id: 'h-vacuum',
        position: [266, 9, -72],
        text: 'ENGAGE VACUUM',
        hint: { keys: ['ENTER'], label: 'Hold' },
      },
    ],
    finish: { zoneId: 'finish', minQuality: 'hard', settleTime: 1 },
    medals: { bronze: 1000, silver: 2000, gold: 3000 },
  };
  return { level, runway, kick, lip, landing, crescent, target, finish, release };
}

/**
 * QA level for auto supports on demanding decks (?view=pylons): wide steep landing slopes and a
 * banked turn — the flare tops must meet the pier heads and never pierce the drive surface.
 */
function makePylonTestLevel(): LevelDef {
  const steep = new TrackPath({ position: [0, 40, 0], pitchDeg: -32 }).straight(70);
  const wide = new TrackPath({ position: [80, 40, 0], pitchDeg: -30 }).straight(70);
  const banked = new TrackPath({ position: [170, 30, 20], rollDeg: 15 }).straight(20).left(50, 70).straight(20);
  return {
    id: 2,
    name: 'PYLON QA',
    subtitle: '',
    description: '',
    theme: 'canyon',
    spawn: { position: [0, 41, 0], yawDeg: 0 },
    killY: -60,
    vacuumEnabled: false,
    fuel: { capacity: 4, regenPerSec: 0.5, regenDelay: 1, start: 1 },
    pieces: [
      { kind: 'ribbon', id: 'steep36', frames: steep.frames, width: 36, style: 'landing', edgeLights: 'cyan' },
      { kind: 'ribbon', id: 'wide40', frames: wide.frames, width: 40, style: 'platform' },
      { kind: 'ribbon', id: 'banked', frames: banked.frames, width: 26, style: 'runway', edgeLights: 'white' },
      // wide boxes: marking-free field variants (no tiled lanes / center lines)
      { kind: 'box', id: 'apron', center: [0, -2, -170], size: [120, 4, 90], style: 'landing', edgeLights: 'cyan' },
      { kind: 'box', id: 'vacpad', center: [140, -2, -170], size: [90, 4, 90], style: 'adhesive', edgeLights: 'red' },
    ],
    zones: [
      // finish on a platform: the arch spans the zone (not the 120 m box) and stands on it
      { id: 'boxFinish', purpose: 'finish', center: [0, 2, -170], halfSize: [14, 4, 20] },
      // aerial trigger (no deck under it): falls back to a slim frame
      { id: 'airTrigger', purpose: 'trigger', center: [80, 40, -120], halfSize: [10, 6, 2], label: 'BOOST', visible: true },
      // trigger on a box deck
      { id: 'padTrigger', purpose: 'trigger', center: [140, 2, -170], halfSize: [12, 3, 16], label: 'ENGAGE', visible: true },
      // trigger wider than its 36 m deck and overhanging the deck end: clipped at both
      {
        id: 'endTrigger',
        purpose: 'trigger',
        center: [steep.at(62).position.x, steep.at(62).position.y + 1.5, steep.at(62).position.z],
        halfSize: [22, 3, 14],
        rotationDeg: [-32, 0, 0],
        label: 'CLIP TEST',
        visible: true,
      },
    ],
    objectives: [],
    floatingHints: [],
    finish: { zoneId: 'none', minQuality: 'hard', settleTime: 1 },
    medals: { bronze: 1, silver: 2, gold: 3 },
  };
}

/* ------------------------------------------------------------------ */
/* Scene helpers                                                        */
/* ------------------------------------------------------------------ */

type Theme = 'day' | 'night' | 'canyon';

const THEMES: Record<
  Theme,
  { zenith: string; horizon: string; fog: string; fogNear: number; fogFar: number; sun: string; sunI: number; sunDir: V3; hemiSky: string; hemiGround: string; hemiI: number }
> = {
  day: {
    zenith: '#3f6ea8',
    horizon: '#e6ddd0',
    fog: '#d9d6cf',
    fogNear: 350,
    fogFar: 5200,
    sun: '#ffdcb0',
    sunI: 3.4,
    sunDir: [-0.62, 0.34, 0.3],
    hemiSky: '#b7cbe2',
    hemiGround: '#b9b2a6',
    hemiI: 0.15,
  },
  canyon: {
    zenith: '#5b78a3',
    horizon: '#f0c79a',
    fog: '#e3bf98',
    fogNear: 300,
    fogFar: 3600,
    sun: '#ffc48a',
    sunI: 3.6,
    sunDir: [0.75, 0.22, 0.2],
    hemiSky: '#a9bedb',
    hemiGround: '#8a5a3a',
    hemiI: 0.45,
  },
  night: {
    zenith: '#05070a',
    horizon: '#0d1117',
    fog: '#07090c',
    fogNear: 200,
    fogFar: 1600,
    sun: '#9fb6d9',
    sunI: 0.12,
    sunDir: [0.3, 0.8, 0.4],
    hemiSky: '#1b2533',
    hemiGround: '#0a0a0a',
    hemiI: 0.12,
  },
};

/** Bloom settings of the matching production themes (morning / night / canyon). */
const BLOOM: Record<Theme, { intensity: number; threshold: number }> = {
  day: { intensity: 0.55, threshold: 1.3 },
  night: { intensity: 0.9, threshold: 0.85 },
  canyon: { intensity: 0.6, threshold: 1.1 },
};

function Sky({ theme }: { theme: Theme }) {
  const t = THEMES[theme];
  const mesh = useMemo(() => {
    const mat = new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        zenith: { value: new Color(t.zenith) },
        horizon: { value: new Color(t.horizon) },
        sunDir: { value: new Vector3(...t.sunDir).normalize() },
        sunCol: { value: new Color(t.sun) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position.z = gl_Position.w;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 zenith; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunCol;
        varying vec3 vDir;
        void main() {
          float h = clamp(vDir.y, -1.0, 1.0);
          vec3 c = mix(horizon, zenith, pow(max(h, 0.0), 0.55));
          c = mix(c, horizon * 0.92, smoothstep(0.0, -0.25, h));
          float s = max(dot(normalize(vDir), sunDir), 0.0);
          c += sunCol * (pow(s, 600.0) * 6.0 + pow(s, 12.0) * 0.18);
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const m = new Mesh(new SphereGeometry(6000, 32, 16), mat);
    m.frustumCulled = false;
    m.renderOrder = -10;
    return m;
  }, [t]);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as ShaderMaterial).dispose();
    },
    [mesh],
  );
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    scene.fog = new Fog(t.fog, t.fogNear, t.fogFar);
    return () => {
      scene.fog = null;
    };
  }, [scene, t]);
  return <primitive object={mesh} />;
}

function Lighting({ theme, focus }: { theme: Theme; focus: V3 }) {
  const t = THEMES[theme];
  const sun = useRef<DirectionalLight>(null);
  const dir = new Vector3(...t.sunDir).normalize();
  useEffect(() => {
    const l = sun.current;
    if (!l) return;
    l.target.position.set(...focus);
    l.target.updateMatrixWorld();
  }, [focus]);
  const pos: V3 = [focus[0] + dir.x * 300, focus[1] + dir.y * 300, focus[2] + dir.z * 300];
  return (
    <>
      <hemisphereLight args={[t.hemiSky, t.hemiGround, t.hemiI]} />
      <directionalLight
        ref={sun}
        position={pos}
        color={t.sun}
        intensity={t.sunI}
        castShadow
        shadow-mapSize={[4096, 4096]}
        shadow-bias={-0.0002}
        shadow-normalBias={0.04}
        shadow-camera-near={10}
        shadow-camera-far={800}
        shadow-camera-left={-160}
        shadow-camera-right={160}
        shadow-camera-top={160}
        shadow-camera-bottom={-160}
      />
      {theme === 'night' ? (
        <Environment resolution={256} frames={1}>
          <color attach="background" args={['#020304']} />
          <Lightformer form="rect" intensity={2.5} color="#fff3e0" position={[0, 30, -60]} scale={[40, 6, 1]} />
          <Lightformer form="rect" intensity={1.2} color="#fff3e0" position={[-60, 20, 0]} rotation-y={Math.PI / 2} scale={[30, 4, 1]} />
          <Lightformer form="rect" intensity={1.5} color={PALETTE.red} position={[60, 5, 0]} rotation-y={-Math.PI / 2} scale={[80, 1, 1]} />
          <Lightformer form="rect" intensity={0.3} color="#8aa0c0" position={[0, 60, 0]} rotation-x={Math.PI / 2} scale={[120, 120, 1]} />
        </Environment>
      ) : (
        <Environment resolution={256} frames={1}>
          {/* stand-in for the env module's in-scene sky probe: sky dome, haze band, sun, cloud-sea bounce */}
          <color attach="background" args={[theme === 'canyon' ? '#7a6656' : '#71839a']} />
          <Lightformer form="rect" intensity={0.9} color={t.zenith} position={[0, 60, 0]} rotation-x={Math.PI / 2} scale={[200, 200, 1]} />
          <Lightformer form="circle" intensity={12} color={t.sun} position={[dir.x * 80, dir.y * 80, dir.z * 80]} scale={[12, 12, 1]} target={[0, 0, 0]} />
          <Lightformer form="rect" intensity={0.8} color={t.horizon} position={[0, 6, -90]} scale={[200, 18, 1]} />
          <Lightformer form="rect" intensity={0.8} color={t.horizon} position={[0, 6, 90]} rotation-y={Math.PI} scale={[200, 18, 1]} />
          <Lightformer form="rect" intensity={0.8} color={theme === 'canyon' ? '#eed2b4' : '#ebe8e2'} position={[0, -40, 0]} rotation-x={-Math.PI / 2} scale={[200, 200, 1]} />
        </Environment>
      )}
    </>
  );
}

/** Stand-in for the env module's cloud sea (soft fbm deck far below), so supports read in context. */
function CloudFloor({ theme }: { theme: Theme }) {
  const tex = useMemo(() => {
    const S = 256;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(S, S);
    const n = fbm(S);
    for (let i = 0; i < S * S; i++) {
      const v = 200 + n[i] * 55;
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v + 4;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const t = new CanvasTexture(c);
    t.wrapS = t.wrapT = RepeatWrapping;
    t.repeat.set(14, 14);
    t.colorSpace = SRGBColorSpace;
    return t;
  }, []);
  useEffect(() => () => tex.dispose(), [tex]);
  if (theme === 'night') return null;
  return (
    <mesh rotation-x={-Math.PI / 2} position={[0, -190, -300]}>
      <planeGeometry args={[14000, 14000]} />
      <meshStandardMaterial map={tex} color={theme === 'canyon' ? '#f3d9bd' : '#f4f1ec'} roughness={1} />
    </mesh>
  );
}

function fbm(S: number): Float32Array {
  const out = new Float32Array(S * S);
  let amp = 1;
  let tot = 0;
  for (let o = 0; o < 5; o++) {
    const cells = 4 << o;
    const lat = new Float32Array(cells * cells).map(() => Math.random());
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const fx = (x / S) * cells;
        const fy = (y / S) * cells;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = fx - x0;
        const ty = fy - y0;
        const sx = tx * tx * (3 - 2 * tx);
        const sy = ty * ty * (3 - 2 * ty);
        const g = (i: number, j: number) => lat[(j % cells) * cells + (i % cells)];
        const a = g(x0, y0) + (g(x0 + 1, y0) - g(x0, y0)) * sx;
        const b = g(x0, y0 + 1) + (g(x0 + 1, y0 + 1) - g(x0, y0 + 1)) * sx;
        out[y * S + x] += (a + (b - a) * sy) * amp;
      }
    }
    tot += amp;
    amp *= 0.5;
  }
  return out.map((v) => v / tot);
}

/** Stylized car-sized proxy (4.46 x 1.12 x 1.98) for scale. */
function CarProxy({ frame }: { frame: TrackFrame }) {
  const pos = frame.position.clone().addScaledVector(frame.up, 0.36);
  return (
    <group position={pos} quaternion={frame.quaternion}>
      <mesh position={[0, 0.1, 0]} castShadow>
        <boxGeometry args={[1.98, 0.5, 4.46]} />
        <meshPhysicalMaterial color={PALETTE.paint} metalness={0.5} roughness={0.25} clearcoat={1} />
      </mesh>
      <mesh position={[0, 0.5, 0.25]} castShadow>
        <boxGeometry args={[1.4, 0.42, 2.0]} />
        <meshStandardMaterial color={PALETTE.glass} metalness={0.8} roughness={0.1} />
      </mesh>
      {[
        [-0.86, -0.0, -1.36],
        [0.86, 0, -1.36],
        [-0.86, 0, 1.36],
        [0.86, 0, 1.36],
      ].map((p, i) => (
        <mesh key={i} position={p as V3} rotation={[0, 0, Math.PI / 2]} castShadow>
          <cylinderGeometry args={[0.36, 0.36, 0.3, 20]} />
          <meshStandardMaterial color="#15181b" roughness={0.8} />
        </mesh>
      ))}
    </group>
  );
}

/** Draw-call / triangle overlay (reads the previous frame's accumulated renderer stats). */
function Stats() {
  const gl = useThree((s) => s.gl);
  const el = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    gl.info.autoReset = false;
    const d = document.createElement('div');
    d.style.cssText =
      'position:fixed;left:12px;bottom:10px;font:12px/1.4 "JetBrains Mono",monospace;color:#c6cbd1;background:rgba(18,20,23,.6);padding:6px 9px;border-radius:6px;z-index:10';
    document.body.appendChild(d);
    el.current = d;
    return () => {
      d.remove();
      gl.info.autoReset = true;
    };
  }, [gl]);
  useFrame(() => {
    const i = gl.info;
    if (el.current) el.current.textContent = `calls ${i.render.calls}  tris ${(i.render.triangles / 1000).toFixed(0)}k  geo ${i.memory.geometries}  tex ${i.memory.textures}`;
    (window as unknown as { __stats: unknown }).__stats = { calls: i.render.calls, triangles: i.render.triangles };
    i.reset();
  }, -1000);
  return null;
}

/* ------------------------------------------------------------------ */
/* Kit showcase                                                         */
/* ------------------------------------------------------------------ */

/** Decor around the main L1-style track: start arch, monumental monoliths, cable-stayed mast. */
function TrackDecor({ demo }: { demo: ReturnType<typeof makeDemoLevel> }) {
  const land = demo.landing.at(40);
  const lz = land.position.z;
  const ly = land.position.y;
  return (
    <>
      <Arch position={[0, 0, 40]} span={32} height={15} legsBelow={60} text="LAUNCH" />
      <Monolith position={[-120, -420, -160]} size={[28, 560, 28]} variant="warm" seams={1} bands={1} />
      <Monolith position={[-165, -420, -330]} size={[20, 470, 20]} variant="graphite" seams={2} bands={2} />
      <Monolith position={[150, -420, -470]} size={[26, 520, 34]} variant="warm" seams={1} bands={1} />
      <CableStays
        anchor={[-34, ly + 62, lz - 20]}
        mastBase={[-34, -260, lz - 20]}
        mastWidth={3}
        points={[
          [-15, ly + 0.1, lz + 30],
          [-15, ly + 0.1, lz + 5],
          [-15, ly + 0.1, lz - 45],
          [-15, ly + 0.1, lz - 70],
        ]}
      />
    </>
  );
}

/** Night arena around the crescent: floodlights (real spots), light rig, grandstand, LED lines, base. */
function ArenaDecor() {
  const aim: V3 = [250, 26, -118];
  return (
    <>
      <Floodlight position={[196, 0, -40]} height={30} aim={aim} light beam={0.05} />
      <Floodlight position={[304, 0, -40]} height={30} aim={aim} light beam={0.05} />
      <Floodlight position={[196, 0, -200]} height={34} aim={[250, 40, -110]} light lenses={[4, 2]} />
      <Floodlight position={[304, 0, -200]} height={34} aim={[250, 40, -110]} light lenses={[4, 2]} />
      <LightRig position={[168, 0, -110]} rotation={[0, Math.PI / 2, 0]} width={44} height={24} count={9} aim={[250, 4, -60]} lights={2} />
      <Grandstand position={[336, 0, -100]} rotation={[0, -Math.PI / 2, 0]} length={110} rows={16} />
      <LEDStrip points={[[160, 0.06, -14], [340, 0.06, -14]]} color="red" width={0.3} height={0.08} spill={1.6} />
      <LEDStrip points={[[214, 0.06, -235], [286, 0.06, -235]]} color="red" width={0.3} height={0.08} spill={1.6} />
      <FacilityBase position={[250, -4, -110]} size={[170, 250]} depth={64} steps={3} />
    </>
  );
}

/** Gallery platform: one of every kit component, plus a canyon backdrop. */
function Gallery() {
  return (
    <>
      <TrussTower position={[-400, 0, -60]} height={40} width={8} depth={8} topLights="red" />
      <TrussTower position={[-340, 0, -60]} height={40} width={8} depth={8} pattern="zigzag" />
      <TrussBeam from={[-396, 38.6, -60]} to={[-344, 38.6, -60]} width={2.6} height={2.6} ledColor="red" ledSide="right" />
      <Arch position={[-262, 0, -60]} span={26} height={14} text="KIT" />
      <Monolith position={[-200, 0, -80]} size={[18, 64, 18]} variant="warm" />
      <Monolith position={[-196, 0, -185]} size={[14, 46, 14]} variant="graphite" seams={2} bands={2} />
      <Grandstand position={[-392, 0, -150]} length={52} rows={12} />
      <LightRig position={[-300, 0, -205]} width={36} height={20} count={7} aim={[-300, 0, -150]} lights={0} />
      <Floodlight position={[-235, 0, -140]} aim={[-290, 0, -190]} />
      <Floodlight position={[-235, 0, -250]} aim={[-290, 0, -190]} lenses={[2, 2]} height={20} />
      <Billboard position={[-392, 0, -282]} text="ROADSTER FLIGHT" subtitle="Architecture kit · test facility" tag="01" width={22} height={6} postHeight={5} />
      <RingGate position={[-322, 12, -282]} radius={9} />
      <CableStays
        anchor={[-250, 48, -300]}
        mastBase={[-250, 0, -300]}
        points={[
          [-214, 0.1, -280],
          [-212, 0.1, -300],
          [-214, 0.1, -320],
          [-286, 0.1, -280],
          [-288, 0.1, -300],
          [-286, 0.1, -320],
        ]}
      />
      <LEDStrip points={[[-420, 0.06, -356], [-180, 0.06, -356]]} color="cyan" width={0.24} />
      <Pylon position={[-400, -4, -40]} height={320} deckWidth={30} />
      <Pylon position={[-200, -4, -40]} height={320} deckWidth={30} />
      <FacilityBase position={[-300, -4, -200]} size={[170, 250]} depth={70} steps={3} />
      <CanyonWall position={[-1060, -260, -260]} rotation={[0, Math.PI / 2, 0]} width={900} height={330} relief={34} seed={4} curve={1100} />
      <RockSpire position={[-760, -240, -420]} height={250} radius={24} seed={5} />
      <RockSpire position={[-840, -240, -120]} height={210} radius={18} seed={8} lean={4} />
      <RockSpire position={[-700, -240, -40]} height={150} radius={12} seed={11} taper={0.7} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Views                                                                */
/* ------------------------------------------------------------------ */

type Demo = ReturnType<typeof makeDemoLevel>;

interface View {
  theme: Theme;
  cam: V3;
  target: V3;
  fov?: number;
  car?: (d: Demo) => TrackFrame;
  /** Camera / target derived from the demo track (overrides cam / target). */
  at?: (d: Demo) => { cam: V3; target: V3; up?: V3 };
}

const v3 = (p: Vector3): V3 => [p.x, p.y, p.z];

/** Driver's-eye view on a track frame: `back` m behind, `height` m above the drive surface, camera up = surface up. */
function driverView(f: TrackFrame, back: number, height: number, ahead: number): { cam: V3; target: V3; up: V3 } {
  return {
    cam: v3(f.position.clone().addScaledVector(f.forward, -back).addScaledVector(f.up, height)),
    target: v3(f.position.clone().addScaledVector(f.forward, ahead).addScaledVector(f.up, height * 0.35)),
    up: v3(f.up),
  };
}

const VIEWS: Record<string, View> = {
  overview: { theme: 'day', cam: [-260, 180, 120], target: [60, -10, -280] },
  runway: { theme: 'day', cam: [3, 3.2, -88], target: [0, 1.6, -150], fov: 62, car: (d) => d.runway.at(222) },
  kicker: { theme: 'day', cam: [-70, 16, -300], target: [0, -2, -360], fov: 55 },
  landing: { theme: 'day', cam: [-55, 30, -400], target: [0, -12, -520], fov: 55, car: (d) => frameAt(d.landing.frames, 90) },
  finish: { theme: 'day', cam: [10, 6, -560], target: [0, 0, -640], fov: 60 },
  crescent: { theme: 'night', cam: [190, 22, 40], target: [250, 30, -100], fov: 50, car: (d) => d.crescent.at(20) },
  crescentSide: { theme: 'night', cam: [100, 30, -95], target: [250, 30, -100], fov: 50 },
  under: { theme: 'day', cam: [-40, -60, -380], target: [0, -20, -480], fov: 60 },
  arena: { theme: 'night', cam: [120, 60, 90], target: [260, 10, -120], fov: 55 },
  kit: { theme: 'day', cam: [-120, 70, 40], target: [-300, 10, -190], fov: 55 },
  kitClose: { theme: 'day', cam: [-250, 14, -10], target: [-300, 14, -90], fov: 55 },
  canyon: { theme: 'canyon', cam: [-520, 40, -300], target: [-1000, 30, -200], fov: 55 },
  canyonSide: { theme: 'canyon', cam: [-640, 120, 380], target: [-1010, -40, -260], fov: 50 },
  styles: { theme: 'day', cam: [-258, 13, -314], target: [-306, 4, -342], fov: 55 },
  climb: { theme: 'night', cam: [250, 4.2, -62], target: [250, 22, -118], fov: 62, car: (d) => d.crescent.at(66) },
  ramp: { theme: 'day', cam: [2, 3.4, -218], target: [0, 2.5, -262], fov: 62, car: (d) => d.runway.at(285) },
  air: { theme: 'day', cam: [4, 16, -330], target: [0, -12, -400], fov: 62 },
  targetClose: { theme: 'day', cam: [16, 9, -455], target: [0, -12, -490], fov: 55, car: (d) => frameAt(d.landing.frames, 100) },
  hints: { theme: 'day', cam: [6, 4, 10], target: [-9, 6, -20], fov: 55 },
  live: { theme: 'day', cam: [8, 6, 28], target: [-6, 4, -20], fov: 55 },
  // --- QA close-ups ---
  /** Driver's view (surface-following camera) approaching the RELEASE marking on the inverted beam. */
  release: { theme: 'night', cam: [0, 0, 0], target: [0, 0, 0], fov: 62, at: (d) => driverView(d.release, 24, 2.4, 10) },
  /** The inverted beam from the arena floor (world up): drive surface, LEDs, marking, truss arm. */
  releaseWorld: {
    theme: 'night',
    cam: [0, 0, 0],
    target: [0, 0, 0],
    fov: 55,
    at: (d) => ({ cam: v3(d.release.position.clone().add(new Vector3(-26, -40, -40))), target: v3(d.release.position) }),
  },
  /** Driver's view entering the overhang (vertical wall -> inverted). */
  invert: { theme: 'night', cam: [0, 0, 0], target: [0, 0, 0], fov: 62, at: (d) => driverView(d.crescent.at(118), 14, 2.2, 12) },
  /** Runway -> kicker junction (markings, LED colour change, trims). */
  junction: { theme: 'day', cam: [7, 2.4, -224], target: [0, 0.5, -252], fov: 55 },
  /** Car-height grazing look at the target rings (z-fighting / shimmer check). */
  targetGraze: {
    theme: 'day',
    cam: [0, 0, 0],
    target: [0, 0, 0],
    fov: 55,
    at: (d) => ({ cam: v3(d.target.position.clone().addScaledVector(d.target.forward, -26).addScaledVector(d.target.up, 1.3).addScaledVector(d.target.right, 4)), target: v3(d.target.position) }),
  },
  /** Skywalk (metal + rails + cyan edge LEDs) through its turn. */
  skywalk: { theme: 'day', cam: [-436, 14, -150], target: [-460, 9, -116], fov: 55 },
  /** Auto supports on steep / wide / banked decks (separate QA level). */
  pylons: { theme: 'canyon', cam: [-70, 10, 80], target: [60, -10, -20], fov: 55 },
  /** Same QA level: wide boxes (field variants), finish arch on a box, triggers. */
  pylonsBoxes: { theme: 'day', cam: [60, 70, -60], target: [70, 0, -170], fov: 55 },
  /** Same QA level: a trigger decal larger than its deck, clipped at the sides and the deck end. */
  pylonsDecal: { theme: 'day', cam: [-30, 40, -10], target: [0, 4, -56], fov: 55 },
  /** Scripted objective switching for the floating-hint fades (see HintFadeDriver). */
  hintfade: { theme: 'day', cam: [10, 6, 12], target: [-9, 6, -20], fov: 55 },
};

/**
 * Optional: render a level authored elsewhere (physics test levels) through <LevelGeometry>, with
 * an automatic overview camera. Loaded with a guarded dynamic import so a broken foreign module
 * cannot break this sandbox. ?level=TEST_RAMP | TEST_VACUUM | TEST_FLAT [&cam=x,y,z&at=x,y,z]
 */
function ExternalLevel({ name, theme }: { name: string; theme: Theme }) {
  const [level, setLevel] = useState<LevelDef | null>(null);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as { target: Vector3; update(): void } | null;
  useEffect(() => {
    let alive = true;
    import('@/game/levels/testLevels')
      .then((mod) => {
        const lv = (mod as unknown as Record<string, LevelDef | undefined>)[name];
        if (alive && lv) setLevel(lv);
      })
      .catch((e) => console.warn('[kit] could not load test levels', e));
    return () => {
      alive = false;
    };
  }, [name]);
  useEffect(() => {
    if (!level) return;
    const params = new URLSearchParams(location.search);
    const box = new Box3();
    for (const p of level.pieces) {
      if (p.kind === 'ribbon') for (const f of p.frames) box.expandByPoint(f.position);
      else box.expandByPoint(new Vector3(...p.center));
    }
    const c = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3()).length();
    const at = params.get('at')?.split(',').map(Number) as V3 | undefined;
    const cam = params.get('cam')?.split(',').map(Number) as V3 | undefined;
    const target = at ? new Vector3(...at) : c;
    camera.position.copy(cam ? new Vector3(...cam) : c.clone().add(new Vector3(-0.55, 0.32, 0.45).multiplyScalar(size * 0.6)));
    camera.lookAt(target);
    if (controls) {
      controls.target.copy(target);
      controls.update();
    }
    runtime.frame.position.copy(camera.position);
  }, [level, camera, controls]);
  void theme;
  return level ? <LevelGeometry level={level} /> : null;
}

/** Points the (non-orbit) camera with an explicit up vector, e.g. the surface up on inverted decks. */
function FixedCamera({ cam, target, up }: { cam: V3; target: V3; up: V3 }) {
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    camera.position.set(...cam);
    camera.up.set(...up).normalize();
    camera.lookAt(...target);
    camera.updateMatrixWorld();
  }, [camera, cam, target, up]);
  return null;
}

/** Exposes the scene for --eval inspection in screenshot runs (dev only). */
function ExposeScene() {
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    (window as unknown as { __scene: unknown }).__scene = scene;
  }, [scene]);
  return null;
}

/**
 * ?view=hintfade — scripted objective timeline for the floating-hint fades, published like the
 * runner does (runtime.frame, prio -100): 0–2 s objective 'demo' (h-thrust visible), 2–4 s 'other'
 * (fades out), 4–6 s back to 'demo', from 6 s objective index 3 via a hint bound to "3".
 * window.__hint reports the h-thrust panel opacity.
 */
function HintFadeDriver() {
  const t = useRef(0);
  const scene = useThree((s) => s.scene);
  useFrame((_, dt) => {
    t.current += Math.min(0.1, dt);
    const o = runtime.frame.snapshot.objective;
    o.id = t.current < 2 || (t.current >= 4 && t.current < 6) ? 'demo' : 'other';
    o.index = t.current >= 6 ? 3 : 1;
    runtime.frame.time = t.current;
    const panel = scene.getObjectByName('hint:h-thrust')?.children[0] as Mesh | undefined;
    const idx = scene.getObjectByName('hint:h-index')?.children[0] as Mesh | undefined;
    const op = (m?: Mesh) => (m && m.parent?.visible ? Number((m.material as { opacity: number }).opacity.toFixed(3)) : 0);
    (window as unknown as { __hint: unknown }).__hint = { t: Number(t.current.toFixed(2)), id: o.id, thrust: op(panel), index3: op(idx) };
  }, -100);
  return null;
}

/**
 * ?churn=N — mounts / unmounts <LevelGeometry> N times (4 frames each) and reports renderer memory
 * before the first mount, while mounted and after the last unmount on window.__churn: geometries
 * must return to the baseline (per-level textures too; only the shared cached library remains).
 */
function ChurnTest({ level, cycles }: { level: LevelDef; cycles: number }) {
  const gl = useThree((s) => s.gl);
  const [mounted, setMounted] = useState(false);
  const st = useRef({ frame: 0, toggles: 0, base: null as null | { geometries: number; textures: number }, peak: null as null | { geometries: number; textures: number } });
  useFrame(() => {
    const s = st.current;
    s.frame++;
    const mem = { geometries: gl.info.memory.geometries, textures: gl.info.memory.textures };
    if (s.frame === 8) s.base = mem;
    if (s.frame < 10 || s.toggles >= cycles * 2) {
      if (s.toggles >= cycles * 2 && s.frame % 4 === 0) {
        (window as unknown as { __churn: unknown }).__churn = { cycles, base: s.base, peak: s.peak, after: mem };
      }
      return;
    }
    if (s.frame % 4 === 0) {
      if (mounted) s.peak = mem;
      s.toggles++;
      setMounted((m) => !m);
    }
  });
  return mounted ? <LevelGeometry level={level} /> : null;
}

function App() {
  const params = new URLSearchParams(location.search);
  const external = params.get('level');
  const viewName = params.get('view') ?? 'overview';
  const view = VIEWS[viewName] ?? VIEWS.overview;
  const theme = (params.get('theme') as Theme | null) ?? view.theme;
  const off = new Set((params.get('off') ?? '').split(',').filter(Boolean));
  const churn = Number(params.get('churn') ?? 0);
  const demo = useMemo(() => {
    // ?led=red:4:ff1e1e — calibration override of an LED tint (before the material library exists)
    const led = params.get('led')?.split(':');
    if (led && led[0] in LED_TINTS) {
      const t = LED_TINTS[led[0] as keyof typeof LED_TINTS];
      if (led[1]) t.intensity = Number(led[1]);
      if (led[2]) t.hex = `#${led[2]}`;
    }
    // measure one-time procedural texture/material generation (reported on window for shots)
    const t0 = performance.now();
    getLevelMaterials();
    const w = window as unknown as { __texMs?: number; __buildMs?: number };
    w.__texMs = Math.max(w.__texMs ?? 0, Math.round(performance.now() - t0));
    const d = makeDemoLevel();
    d.level.floatingHints.push({ id: 'h-index', position: [9, 6, -24], text: 'INDEX THREE', objectiveId: '3' });
    if (params.has('timing')) {
      const t1 = performance.now();
      buildLevelGeometry(d.level).dispose();
      w.__buildMs = Math.round(performance.now() - t1);
    }
    return d;
  }, []);
  const pylonLevel = useMemo(() => (viewName.startsWith('pylons') ? makePylonTestLevel() : null), [viewName]);
  const carFrame = view.car?.(demo);
  const spec = useMemo(() => {
    const s: { cam: V3; target: V3; up?: V3 } = view.at ? view.at(demo) : { cam: view.cam, target: view.target };
    // ?cam=x,y,z&at=x,y,z override any view (ExternalLevel reads them itself)
    const num = (k: string) => params.get(k)?.split(',').map(Number) as V3 | undefined;
    if (!external) {
      s.cam = num('cam') ?? s.cam;
      s.target = num('at') ?? s.target;
    }
    return s;
  }, [view, demo]);

  const live = viewName === 'live';
  const hintfade = viewName === 'hintfade';
  useEffect(() => {
    if (live || hintfade) return; // the mock runtime / scripted driver drives runtime.frame
    runtime.frame.snapshot.objective.id = 'demo';
    if (carFrame) runtime.frame.position.copy(carFrame.position);
    else runtime.frame.position.set(...spec.cam);
  }, [carFrame, spec, live, hintfade]);

  return (
    <DevCanvas camera={{ position: spec.cam, fov: view.fov ?? 55 }} orbit={!spec.up} orbitTarget={spec.target} readyFrames={45} dpr={1.5}>
      {spec.up && <FixedCamera cam={spec.cam} target={spec.target} up={spec.up} />}
      <ExposeScene />
      <Sky theme={theme} />
      <CloudFloor theme={theme} />
      <Lighting theme={theme} focus={spec.target} />
      {external ? (
        <ExternalLevel name={external} theme={theme} />
      ) : churn > 0 ? (
        <ChurnTest level={demo.level} cycles={churn} />
      ) : pylonLevel ? (
        <LevelGeometry level={pylonLevel} />
      ) : (
        <>
          {/* the demo level mixes day and night areas: pick the LED spill of the view's theme */}
          {!off.has('level') && <LevelGeometry level={demo.level} options={{ ledSpill: theme === 'night' ? 1 : undefined }} />}
          {!off.has('track') && <TrackDecor demo={demo} />}
          {!off.has('arena') && <ArenaDecor />}
          {!off.has('gallery') && <Gallery />}
        </>
      )}
      {carFrame && <CarProxy frame={carFrame} />}
      {live && <MockRuntimeDriver />}
      {hintfade && <HintFadeDriver />}
      <Stats />
      {!off.has('post') && (
        // mirrors the production PostFX essentials: per-theme bloom threshold + AgX tone mapping
        <EffectComposer multisampling={4}>
          <Bloom mipmapBlur intensity={BLOOM[theme].intensity} luminanceThreshold={BLOOM[theme].threshold} luminanceSmoothing={0.25} radius={0.75} />
          <ToneMapping mode={ToneMappingMode.AGX} />
        </EffectComposer>
      )}
    </DevCanvas>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
