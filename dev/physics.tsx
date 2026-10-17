/**
 * Physics debug viewer — play-test the real GameSim before integration.
 *
 *   http://127.0.0.1:5173/dev/physics.html?level=flat|ramp|vacuum[&autopilot=1][&cam=chase|side|high]
 *
 * Keys (ARCHITECTURE §12): W/S/↑/↓ throttle·pitch, A/D/←/→ steer·yaw, Q/E roll, Space thrust,
 * Enter vacuum, Shift stabilize, R restart, P/Esc pause — plus T demo autopilot, C camera, G contacts.
 *
 * The page owns a fixed-step accumulator (120 Hz) with interpolation and honors the sim's
 * requested time scale; crashes auto-restart after 1.6 s. `window.__sim` exposes the GameSim and
 * `window.__viewer` a few controls for scripted captures (scripts/shot.mjs --eval).
 */
import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import * as THREE from 'three';
import '@/styles/base.css';
import { TEST_LEVELS, type TestLevelKey } from '@/game/levels/testLevels';
import { initPhysics } from '@/game/physics/initPhysics';
import type { Autopilot } from '@/game/sim/autopilot';
import { demoPilotFor } from '@/game/sim/demoPilots';
import { GameSim } from '@/game/sim/GameSim';
import { createRayHit } from '@/game/physics/PhysicsWorld';
import { buildRibbon, type MeshData } from '@/game/track/Ribbon';
import { boxMatrix } from '@/game/track/zones';
import { KMH, TUNING } from '@/game/tuning';
import {
  NEUTRAL_INPUT,
  type EdgeLight,
  type GameEvent,
  type InputState,
  type LandingQuality,
  type LevelDef,
  type RibbonPieceDef,
  type TrackStyle,
} from '@/game/types';
import { CHASSIS_COLLIDERS, HARDPOINTS, NOZZLES, RCS_PORTS, VEHICLE } from '@/game/vehicleSpec';
import { PALETTE } from '@/render/palette';

/* ================================================================== */
/* Config                                                              */
/* ================================================================== */

const params = new URLSearchParams(location.search);
const LEVEL_KEY: TestLevelKey = (['flat', 'ramp', 'vacuum'] as const).includes(params.get('level') as TestLevelKey)
  ? (params.get('level') as TestLevelKey)
  : 'ramp';
const LEVEL: LevelDef = TEST_LEVELS[LEVEL_KEY];
const CRASH_RESTART = 1.6; // real seconds
const COMPLETE_RESTART = 6; // real seconds, only while the demo autopilot loops
type CamMode = 'chase' | 'side' | 'high';
const CAM_MODES: CamMode[] = ['chase', 'side', 'high'];

const QUALITY_COLOR: Record<LandingQuality, string> = {
  perfect: PALETTE.cyan,
  clean: PALETTE.warmWhite,
  hard: PALETTE.amber,
  crash: PALETTE.danger,
};

/* ================================================================== */
/* Controller (outside React: sim lifecycle, input, fixed stepping)     */
/* ================================================================== */

interface LogLine {
  t: number;
  text: string;
  color?: string;
}

class ViewerController {
  readonly level = LEVEL;
  sim: GameSim;
  readonly keys = new Set<string>();
  paused = false;
  camMode: CamMode = (CAM_MODES as string[]).includes(params.get('cam') ?? '') ? (params.get('cam') as CamMode) : 'chase';
  showContacts = false;
  /** Interpolated chassis pose for rendering. */
  readonly pose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  readonly log: LogLine[] = [];
  banner: { text: string; sub: string; color: string; until: number } | null = null;
  runTime = 0;
  private acc = 0;
  private crashClock = -1;
  private completeClock = -1;
  private pilot: Autopilot | null = null;
  private recent: GameEvent[] = [];
  private readonly input: InputState = { ...NEUTRAL_INPUT };
  realTime = 0;

  constructor() {
    this.sim = new GameSim(this.level, { firstAttempt: true, flightAssist: true });
    this.ingest(this.sim.drainEvents());
    this.syncPose(1);
    if (params.get('autopilot') === '1') this.setAutopilot(true);
  }

  get autopilotOn(): boolean {
    return this.pilot !== null;
  }

  setAutopilot(on: boolean): void {
    this.pilot = on ? demoPilotFor(this.level) : null;
    if (on && !this.pilot) this.note('no demo autopilot for this level', PALETTE.amber);
    else this.note(on ? 'autopilot ON' : 'autopilot OFF', PALETTE.cyan);
    if (this.pilot) this.reset();
  }

  reset(): void {
    this.sim.setOptions({ firstAttempt: false });
    this.sim.reset();
    this.pilot?.reset();
    this.acc = 0;
    this.crashClock = -1;
    this.completeClock = -1;
    this.runTime = 0;
    this.banner = null;
    this.recent = [];
    this.ingest(this.sim.drainEvents());
    this.syncPose(1);
  }

  private sampleKeys(): InputState {
    const k = this.keys;
    const i = this.input;
    i.throttle = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    i.steer = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    i.roll = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    i.boost = k.has('Space');
    i.vacuum = k.has('Enter') || k.has('NumpadEnter');
    i.stabilize = k.has('ShiftLeft') || k.has('ShiftRight');
    return i;
  }

  private nextInput(): InputState {
    const s = this.sim.snapshot;
    if (s.phase === 'complete') return { ...NEUTRAL_INPUT, throttle: s.vehicle.forwardSpeed > 1 ? -0.45 : 0 };
    if (s.phase === 'crashed') return NEUTRAL_INPUT;
    if (this.pilot) return this.pilot.next(s, this.recent);
    return this.sampleKeys();
  }

  /** Called once per rendered frame with the real frame delta. */
  update(realDt: number): void {
    const dt = Math.min(0.1, Math.max(0, realDt));
    this.realTime += dt;
    if (!this.paused) {
      const scale = Math.min(1, Math.max(0.05, this.sim.snapshot.timeScale || 1));
      this.acc += dt * scale;
      let ticks = 0;
      while (this.acc >= TUNING.dt && ticks < TUNING.maxTicksPerFrame) {
        this.sim.step(this.nextInput());
        this.recent = this.sim.drainEvents();
        this.ingest(this.recent);
        this.acc -= TUNING.dt;
        ticks++;
      }
      if (ticks >= TUNING.maxTicksPerFrame) this.acc = 0;
      this.runTime += dt;
      if (this.crashClock >= 0 && (this.crashClock += dt) >= CRASH_RESTART) this.reset();
      if (this.completeClock >= 0 && this.pilot && (this.completeClock += dt) >= COMPLETE_RESTART) this.reset();
    }
    this.syncPose(Math.min(1, this.acc / TUNING.dt));
  }

  private syncPose(alpha: number): void {
    const s = this.sim;
    this.pose.position.lerpVectors(s.prevPose.position, s.currPose.position, alpha);
    this.pose.quaternion.slerpQuaternions(s.prevPose.quaternion, s.currPose.quaternion, alpha);
  }

  note(text: string, color?: string): void {
    this.log.push({ t: this.sim.snapshot.time, text, color });
    if (this.log.length > 12) this.log.shift();
  }

  private ingest(events: GameEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'crash':
          this.crashClock = 0;
          this.note(`CRASH · ${e.reason} · ${e.impactSpeed.toFixed(1)} m/s`, PALETTE.danger);
          this.banner = { text: 'CRASH', sub: e.reason.toUpperCase(), color: PALETTE.danger, until: this.realTime + 1.6 };
          break;
        case 'landing': {
          const r = e.result;
          this.note(
            `LANDING ${r.quality.toUpperCase()} · ${r.angleDeg.toFixed(1)}° · ${r.impactSpeed.toFixed(1)} m/s · drift ${r.driftDeg.toFixed(0)}° · +${r.points}`,
            QUALITY_COLOR[r.quality],
          );
          this.banner = {
            text: r.quality.toUpperCase(),
            sub: `${r.angleDeg.toFixed(1)}°  ·  ${r.impactSpeed.toFixed(1)} m/s  ·  +${r.points}`,
            color: QUALITY_COLOR[r.quality],
            until: this.realTime + 2,
          };
          break;
        }
        case 'takeoff':
          this.note(`takeoff · ${(e.speed * KMH).toFixed(0)} km/h`);
          break;
        case 'trick':
          this.note(`${e.trick.label} +${e.trick.points}`, PALETTE.cyanGlow);
          break;
        case 'levelComplete':
          this.completeClock = 0;
          this.note(`LEVEL COMPLETE · ${e.result.score} · ${e.result.medal.toUpperCase()}`, PALETTE.cyan);
          this.banner = { text: 'COMPLETE', sub: `${e.result.score} pts · ${e.result.medal.toUpperCase()}`, color: PALETTE.cyan, until: this.realTime + 5 };
          break;
        case 'objective':
          this.note(`objective · ${e.title}`);
          break;
        case 'vacuumEngaged':
          this.note('vacuum engaged', PALETTE.cyan);
          break;
        case 'vacuumReleased':
          this.note('vacuum released', PALETTE.titanium300);
          break;
        case 'fuelEmpty':
          this.note('fuel empty', PALETTE.amber);
          break;
        case 'reset':
          this.note('reset');
          break;
        default:
          break;
      }
    }
  }
}

let controller: ViewerController;

/* ================================================================== */
/* Keyboard                                                            */
/* ================================================================== */

const CAPTURED = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Tab']);

function useKeyboard(): void {
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (CAPTURED.has(e.code)) e.preventDefault();
      controller.keys.add(e.code);
      if (e.repeat) return;
      if (e.code === 'KeyR') controller.reset();
      else if (e.code === 'KeyP' || e.code === 'Escape') controller.paused = !controller.paused;
      else if (e.code === 'KeyT') controller.setAutopilot(!controller.autopilotOn);
      else if (e.code === 'KeyC') controller.camMode = CAM_MODES[(CAM_MODES.indexOf(controller.camMode) + 1) % CAM_MODES.length];
      else if (e.code === 'KeyG') controller.showContacts = !controller.showContacts;
    };
    const up = (e: KeyboardEvent) => controller.keys.delete(e.code);
    const blur = () => controller.keys.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);
}

/* ================================================================== */
/* Sim driver (runs first each frame)                                  */
/* ================================================================== */

function SimDriver() {
  useFrame((_, delta) => controller.update(delta), -100);
  return null;
}

/* ================================================================== */
/* Level geometry                                                      */
/* ================================================================== */

function meshGeometry(m: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  g.computeBoundingSphere();
  return g;
}

const SURFACE_TILE = 16; // meters of track per texture tile

/** Procedural top-surface texture per style (u across the width, v along the track). */
function surfaceTexture(style: TrackStyle): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 512;
  const g = c.getContext('2d')!;
  const W = c.width;
  const H = c.height;
  const noise = (base: string, amount: number, n = 2600) => {
    g.fillStyle = base;
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < n; i++) {
      const v = Math.random() * amount;
      g.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,0'},${v})`;
      g.fillRect(Math.random() * W, Math.random() * H, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }
  };
  switch (style) {
    case 'runway':
      noise(PALETTE.asphalt, 0.05);
      g.fillStyle = 'rgba(241,237,230,0.85)';
      g.fillRect(W * 0.03, 0, W * 0.018, H);
      g.fillRect(W * 0.952, 0, W * 0.018, H);
      g.fillRect(W * 0.494, 0, W * 0.012, H * 0.5);
      break;
    case 'ramp': {
      noise('#2f2c2a', 0.05);
      for (let k = 0; k < 2; k++) {
        const y0 = (k * H) / 2;
        g.fillStyle = k % 2 ? PALETTE.warmWhite : PALETTE.orange;
        g.beginPath();
        g.moveTo(0, y0 + H * 0.3);
        g.lineTo(W / 2, y0);
        g.lineTo(W, y0 + H * 0.3);
        g.lineTo(W, y0 + H * 0.4);
        g.lineTo(W / 2, y0 + H * 0.1);
        g.lineTo(0, y0 + H * 0.4);
        g.closePath();
        g.fill();
      }
      break;
    }
    case 'landing':
      noise('#a7a299', 0.06);
      g.strokeStyle = 'rgba(40,40,40,0.25)';
      g.lineWidth = 2;
      for (let y = 0; y <= H; y += H / 4) g.strokeRect(-2, y, W + 4, 0);
      g.strokeRect(W / 2, -2, 0, H + 4);
      break;
    case 'adhesive':
      noise('#8a9094', 0.04);
      g.strokeStyle = 'rgba(56,232,255,0.16)';
      g.lineWidth = 1;
      for (let x = 0; x <= W; x += W / 24) g.strokeRect(x, -1, 0, H + 2);
      for (let y = 0; y <= H; y += H / 32) g.strokeRect(-1, y, W + 2, 0);
      g.fillStyle = 'rgba(241,237,230,0.9)';
      g.fillRect(W * 0.495, 0, W * 0.01, H);
      break;
    case 'metal':
      noise(PALETTE.titanium400, 0.03, 600);
      for (let i = 0; i < 400; i++) {
        g.fillStyle = `rgba(255,255,255,${Math.random() * 0.05})`;
        g.fillRect(Math.random() * W, 0, 1, H);
      }
      break;
    default:
      noise(PALETTE.concreteDark, 0.05);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 1 / SURFACE_TILE);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** 10 m concrete grid for box decks (repeat set per box). */
function gridTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = PALETTE.graphite700;
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1500; i++) {
    g.fillStyle = `rgba(255,255,255,${Math.random() * 0.03})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  g.strokeStyle = 'rgba(163,170,178,0.35)';
  g.lineWidth = 2;
  g.strokeRect(1, 1, 254, 254);
  g.strokeStyle = 'rgba(163,170,178,0.12)';
  g.lineWidth = 1;
  g.strokeRect(128, -2, 0, 260);
  g.strokeRect(-2, 128, 260, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

const EDGE_COLOR: Record<Exclude<EdgeLight, 'none'>, string> = {
  cyan: PALETTE.cyan,
  red: PALETTE.red,
  orange: PALETTE.orange,
  white: PALETTE.warmWhite,
};

/** Thin emissive strip along a ribbon edge (inset 0.15 m, raised 2 cm). */
function edgeStrip(piece: RibbonPieceDef, edge: THREE.Vector3[], side: -1 | 1): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const p = new THREE.Vector3();
  piece.frames.forEach((f, i) => {
    for (const o of [0.12, 0.3]) {
      p.copy(edge[i]).addScaledVector(f.right, -side * o).addScaledVector(f.up, 0.02);
      pos.push(p.x, p.y, p.z);
    }
    if (i > 0) {
      const a = (i - 1) * 2;
      if (side > 0) idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      else idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

interface LevelAssets {
  group: THREE.Group;
  dispose: () => void;
}

function buildLevelAssets(level: LevelDef): LevelAssets {
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const sideMat = keep(new THREE.MeshStandardMaterial({ color: PALETTE.graphite600, roughness: 0.75, metalness: 0.1 }));
  const railMat = keep(new THREE.MeshStandardMaterial({ color: PALETTE.titanium300, roughness: 0.35, metalness: 0.7 }));
  const textures = new Map<TrackStyle, THREE.CanvasTexture>();
  const topMat = (style: TrackStyle) => {
    let tex = textures.get(style);
    if (!tex) {
      tex = keep(surfaceTexture(style));
      textures.set(style, tex);
    }
    const metal = style === 'metal';
    return keep(
      new THREE.MeshStandardMaterial({
        map: tex,
        roughness: style === 'adhesive' ? 0.38 : metal ? 0.4 : 0.82,
        metalness: metal ? 0.6 : style === 'adhesive' ? 0.15 : 0,
      }),
    );
  };

  for (const piece of level.pieces) {
    if (piece.kind === 'ribbon') {
      const geo = buildRibbon(piece.frames, { width: piece.width, thickness: piece.thickness ?? 1.2, rails: piece.rails ?? 0 });
      const top = new THREE.Mesh(keep(meshGeometry(geo.top)), topMat(piece.style));
      top.receiveShadow = true;
      const sides = new THREE.Mesh(keep(meshGeometry(geo.sides)), sideMat);
      sides.receiveShadow = true;
      sides.castShadow = true;
      group.add(top, sides);
      if (geo.rails) {
        const rails = new THREE.Mesh(keep(meshGeometry(geo.rails)), railMat);
        rails.castShadow = true;
        group.add(rails);
      }
      const light = piece.edgeLights ?? 'none';
      if (light !== 'none') {
        const mat = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(EDGE_COLOR[light]).multiplyScalar(1.6), toneMapped: false, side: THREE.DoubleSide }));
        group.add(new THREE.Mesh(keep(edgeStrip(piece, geo.leftEdge, -1)), mat));
        group.add(new THREE.Mesh(keep(edgeStrip(piece, geo.rightEdge, 1)), mat));
      }
    } else {
      const [sx, sy, sz] = piece.size;
      const geom = keep(new THREE.BoxGeometry(sx, sy, sz));
      let mat: THREE.Material;
      if (piece.style === 'platform' || piece.style === 'landing') {
        const tex = keep(gridTexture());
        tex.repeat.set(sx / 10, sz / 10);
        mat = keep(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
      } else if (piece.style === 'glass') {
        mat = keep(new THREE.MeshStandardMaterial({ color: PALETTE.glass, roughness: 0.08, metalness: 0.3, transparent: true, opacity: 0.6 }));
      } else {
        mat = keep(new THREE.MeshStandardMaterial({ color: PALETTE.titanium400, roughness: 0.45, metalness: 0.6 }));
      }
      const mesh = new THREE.Mesh(geom, mat);
      mesh.applyMatrix4(boxMatrix(piece.center, piece.rotationDeg));
      mesh.receiveShadow = true;
      mesh.castShadow = sx < 200;
      group.add(mesh);
    }
  }

  // zones: translucent volumes with outlines (target cyan, trigger orange, gate white)
  for (const z of level.zones) {
    const visible = z.visible ?? (z.purpose === 'target' || z.purpose === 'gate' || z.purpose === 'finish');
    if (!visible) continue;
    const color = z.purpose === 'target' ? PALETTE.cyan : z.purpose === 'trigger' ? PALETTE.orange : PALETTE.warmWhite;
    const box = keep(new THREE.BoxGeometry(z.halfSize[0] * 2, z.halfSize[1] * 2, z.halfSize[2] * 2));
    const fill = new THREE.Mesh(
      box,
      keep(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.06, depthWrite: false, toneMapped: false })),
    );
    const lines = new THREE.LineSegments(
      keep(new THREE.EdgesGeometry(box)),
      keep(new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55, toneMapped: false })),
    );
    const m = boxMatrix(z.center, z.rotationDeg);
    fill.applyMatrix4(m);
    lines.applyMatrix4(m);
    group.add(fill, lines);
  }
  return { group, dispose: () => disposables.forEach((d) => d.dispose()) };
}

function LevelMeshes() {
  const assets = useMemo(() => buildLevelAssets(controller.level), []);
  useEffect(() => () => assets.dispose(), [assets]);
  return <primitive object={assets.group} />;
}

/* ================================================================== */
/* Environment                                                         */
/* ================================================================== */

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const SKY_FRAG = /* glsl */ `
  uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uGround;
  varying vec3 vDir;
  void main() {
    float h = vDir.y;
    vec3 c = h > 0.0 ? mix(uHorizon, uZenith, pow(h, 0.55)) : mix(uHorizon, uGround, pow(-h, 0.4));
    gl_FragColor = vec4(c, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

function Environment() {
  const night = controller.level.theme === 'night';
  const sky = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          uZenith: { value: new THREE.Color(night ? '#060912' : '#2f5f93') },
          uHorizon: { value: new THREE.Color(night ? '#1d2433' : '#e4d6c1') },
          uGround: { value: new THREE.Color(night ? '#050608' : '#41464d') },
        },
      }),
    [night],
  );
  const sun = useRef<THREE.DirectionalLight>(null!);
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);
  // offline studio environment (PMREM-baked RoomEnvironment) for paint / glass reflections
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const env = pmrem.fromScene(room, 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = night ? 0.25 : 0.45;
    return () => {
      scene.environment = null;
      env.dispose();
      room.dispose();
      pmrem.dispose();
    };
  }, [gl, scene, night]);
  useEffect(() => {
    scene.fog = new THREE.Fog(night ? '#1a1f2b' : '#c9bcab', 250, 2600);
    const target = sun.current.target;
    scene.add(target);
    return () => {
      scene.remove(target);
      scene.fog = null;
      sky.dispose();
    };
  }, [scene, night, sky]);
  // the shadow frustum follows the car
  useFrame(() => {
    const p = controller.pose.position;
    sun.current.position.set(p.x + 40, p.y + 70, p.z + 25);
    sun.current.target.position.copy(p);
  });
  const ground = useMemo(() => {
    const tex = gridTexture();
    tex.repeat.set(400, 400);
    return new THREE.MeshStandardMaterial({ map: tex, color: night ? '#3a4150' : '#8d8f8c', roughness: 1 });
  }, [night]);
  useEffect(
    () => () => {
      ground.map?.dispose();
      ground.dispose();
    },
    [ground],
  );
  const groundY = Math.min(-60, controller.level.killY - 20);
  return (
    <>
      <mesh material={sky} renderOrder={-1} frustumCulled={false}>
        <sphereGeometry args={[5000, 32, 16]} />
      </mesh>
      {/* distant ground far below the floating structures: reads height and speed */}
      <mesh material={ground} position={[0, groundY, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[8000, 8000]} />
      </mesh>

      <hemisphereLight args={[night ? '#5b6b8f' : '#dfe8f2', night ? '#0d0f14' : '#3b3631', night ? 0.3 : 0.45]} />
      <directionalLight
        ref={sun}
        color={night ? '#bcd0ff' : '#fff1dc'}
        intensity={night ? 1.4 : 2.1}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.04}
        shadow-camera-left={-45}
        shadow-camera-right={45}
        shadow-camera-top={45}
        shadow-camera-bottom={-45}
        shadow-camera-near={1}
        shadow-camera-far={220}
      />
    </>
  );
}

/* ================================================================== */
/* Car                                                                 */
/* ================================================================== */

const _ts = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);
/** Orientation of each RCS jet cone (cone +Y → jet direction). */
const RCS_QUATS = RCS_PORTS.map((p) => new THREE.Quaternion().setFromUnitVectors(Y_AXIS, new THREE.Vector3(...p.dir)));

function Car() {
  const root = useRef<THREE.Group>(null!);
  const steer = useRef<(THREE.Group | null)[]>([]);
  const spin = useRef<(THREE.Group | null)[]>([]);
  const flames = useRef<(THREE.Mesh | null)[]>([]);
  const glow = useRef<THREE.Mesh>(null!);
  const jets = useRef<(THREE.Mesh | null)[]>([]);
  const contacts = useRef<(THREE.Mesh | null)[]>([]);

  // RCS port → normalized reaction torque direction (local), for jet visuals from `rcs`
  const portTorque = useMemo(
    () =>
      RCS_PORTS.map((p) => {
        const r = new THREE.Vector3(...p.position).sub(new THREE.Vector3(...VEHICLE.centerOfMass));
        return r.cross(new THREE.Vector3(...p.dir).negate()).normalize();
      }),
    [],
  );
  const cmd = useMemo(() => new THREE.Vector3(), []);

  useFrame((state) => {
    const s = controller.sim.snapshot;
    const v = s.vehicle;
    root.current.position.copy(controller.pose.position);
    root.current.quaternion.copy(controller.pose.quaternion);
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i];
      const sg = steer.current[i];
      const sp = spin.current[i];
      if (sg) {
        sg.position.set(HARDPOINTS[i][0], HARDPOINTS[i][1] - w.suspensionLength, HARDPOINTS[i][2]);
        sg.rotation.y = w.steerAngle;
      }
      if (sp) sp.rotation.x = -w.spinAngle;
      const c = contacts.current[i];
      if (c) {
        c.visible = controller.showContacts && w.grounded;
        c.position.copy(w.contactPoint);
      }
    }
    const flicker = 0.85 + 0.15 * Math.sin(state.clock.elapsedTime * 63) * Math.sin(state.clock.elapsedTime * 29);
    for (const f of flames.current) {
      if (!f) continue;
      const k = v.boostLevel;
      const len = (0.4 + 2.6 * k) * flicker;
      f.visible = k > 0.02;
      f.scale.set(0.8 + 0.4 * k, len, 0.8 + 0.4 * k);
      f.position.y = len / 2; // base stays on the nozzle
    }
    const strength = v.vacuum.strength;
    glow.current.visible = strength > 0.01;
    (glow.current.material as THREE.MeshBasicMaterial).opacity = 0.75 * strength;
    cmd.set(v.rcs.pitch, v.rcs.yaw, -v.rcs.roll);
    const mag = Math.min(1, cmd.length());
    if (mag > 0.01) cmd.normalize();
    jets.current.forEach((j, i) => {
      if (!j) return;
      const k = mag > 0.05 ? Math.max(0, portTorque[i].dot(cmd)) * mag : 0;
      j.visible = k > 0.08;
      j.scale.setScalar(0.4 + 0.9 * k);
    });
  });

  const tub = CHASSIS_COLLIDERS[0];
  const cabin = CHASSIS_COLLIDERS[1];
  return (
    <>
      <group ref={root}>
        <RoundedBox
          args={[(tub.halfExtents[0] + tub.borderRadius) * 2, (tub.halfExtents[1] + tub.borderRadius) * 2, (tub.halfExtents[2] + tub.borderRadius) * 2]}
          radius={tub.borderRadius}
          smoothness={3}
          position={tub.center}
          castShadow
        >
          <meshPhysicalMaterial color={PALETTE.paint} metalness={0.55} roughness={0.3} clearcoat={1} clearcoatRoughness={0.15} />
        </RoundedBox>
        <RoundedBox
          args={[(cabin.halfExtents[0] + cabin.borderRadius) * 2, (cabin.halfExtents[1] + cabin.borderRadius) * 2, (cabin.halfExtents[2] + cabin.borderRadius) * 2]}
          radius={cabin.borderRadius}
          smoothness={3}
          position={cabin.center}
          castShadow
        >
          <meshPhysicalMaterial color="#1b2430" metalness={0.4} roughness={0.2} clearcoat={0.6} clearcoatRoughness={0.25} envMapIntensity={0.9} />
        </RoundedBox>
        {/* light bars */}
        <mesh position={[0, 0.12, VEHICLE.noseZ + 0.02]}>
          <boxGeometry args={[1.5, 0.035, 0.02]} />
          <meshBasicMaterial color={new THREE.Color(PALETTE.cyanGlow).multiplyScalar(2)} toneMapped={false} />
        </mesh>
        <mesh position={[0, 0.16, VEHICLE.tailZ - 0.02]}>
          <boxGeometry args={[1.6, 0.04, 0.02]} />
          <meshBasicMaterial color={new THREE.Color(PALETTE.red).multiplyScalar(1.6)} toneMapped={false} />
        </mesh>
        {/* wheels: steer group → spin group → tire + rim + spoke bar */}
        {HARDPOINTS.map((hp, i) => {
          const width = i < 2 ? VEHICLE.wheelWidthFront : VEHICLE.wheelWidthRear;
          const outward = hp[0] < 0 ? -1 : 1;
          return (
            <group key={i} ref={(g) => void (steer.current[i] = g)}>
              <group ref={(g) => void (spin.current[i] = g)}>
                <mesh rotation={[0, 0, Math.PI / 2]} castShadow>
                  <cylinderGeometry args={[VEHICLE.wheelRadius, VEHICLE.wheelRadius, width, 28]} />
                  <meshStandardMaterial color="#141619" roughness={0.92} />
                </mesh>
                <mesh rotation={[0, 0, Math.PI / 2]} position={[outward * (width / 2 + 0.002), 0, 0]}>
                  <cylinderGeometry args={[0.235, 0.235, 0.01, 24]} />
                  <meshStandardMaterial color={PALETTE.titanium300} metalness={0.8} roughness={0.3} />
                </mesh>
                <mesh position={[outward * (width / 2 + 0.01), 0, 0]}>
                  <boxGeometry args={[0.01, 0.44, 0.06]} />
                  <meshStandardMaterial color={PALETTE.graphite900} roughness={0.6} />
                </mesh>
              </group>
            </group>
          );
        })}
        {/* rocket plumes (exhaust along +Z) */}
        {NOZZLES.map((n, i) => (
          // group +Y → +Z (exhaust direction); cone base on the nozzle, apex downstream
          <group key={i} position={n.position} rotation={[Math.PI / 2, 0, 0]}>
          <mesh ref={(m) => void (flames.current[i] = m)} visible={false}>
            <coneGeometry args={[n.radius, 1, 18, 1, true]} />
            <meshBasicMaterial
              color={new THREE.Color(PALETTE.orange).multiplyScalar(0.85)}
              transparent
              opacity={0.6}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
              toneMapped={false}
              side={THREE.DoubleSide}
            />
          </mesh>
          </group>
        ))}
        {/* vacuum underglow */}
        <mesh ref={glow} position={[0, VEHICLE.floorY - 0.01, 0]} rotation={[Math.PI / 2, 0, 0]} visible={false}>
          <planeGeometry args={[1.7, 3.8]} />
          <meshBasicMaterial color={PALETTE.cyan} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} side={THREE.DoubleSide} />
        </mesh>
        {/* cold-gas RCS puffs */}
        {RCS_PORTS.map((p, i) => (
          // group +Y → jet direction; flipped cone: apex at the port, puff widening outward
          <group key={i} position={p.position} quaternion={RCS_QUATS[i]}>
            <mesh ref={(m) => void (jets.current[i] = m)} position={[0, 0.225, 0]} rotation={[Math.PI, 0, 0]} visible={false}>
              <coneGeometry args={[0.08, 0.45, 10, 1, true]} />
              <meshBasicMaterial color="#dff8ff" transparent opacity={0.7} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
            </mesh>
          </group>
        ))}
      </group>
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} ref={(m) => void (contacts.current[i] = m)} visible={false}>
          <sphereGeometry args={[0.07, 10, 8]} />
          <meshBasicMaterial color={PALETTE.amber} toneMapped={false} />
        </mesh>
      ))}
    </>
  );
}

/* ================================================================== */
/* Trajectory prediction                                               */
/* ================================================================== */

function Prediction() {
  const max = TUNING.prediction.maxPoints;
  // dotted arc (instanced: one draw call, no per-frame allocation) + impact ring tinted by quality
  const dots = useMemo(() => {
    const m = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.14, 8, 6),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.cyan).multiplyScalar(1.4), toneMapped: false, transparent: true, opacity: 0.9 }),
      max,
    );
    m.frustumCulled = false;
    m.count = 0;
    return m;
  }, [max]);
  const ring = useRef<THREE.Mesh>(null!);
  const tmp = useMemo(() => new THREE.Matrix4(), []);
  useEffect(
    () => () => {
      dots.geometry.dispose();
      (dots.material as THREE.Material).dispose();
      dots.dispose();
    },
    [dots],
  );
  useFrame(() => {
    const pred = controller.sim.snapshot.prediction;
    const show = !!pred && pred.valid;
    ring.current.visible = show;
    if (!show || !pred) {
      dots.count = 0;
      return;
    }
    const n = Math.min(max, pred.path.length);
    // skip the first samples (inside/under the car)
    let k = 0;
    for (let i = 2; i < n; i++) {
      const p = pred.path[i];
      const scale = 0.6 + 0.4 * (i / n);
      tmp.makeScale(scale, scale, scale).setPosition(p.x, p.y, p.z);
      dots.setMatrixAt(k++, tmp);
    }
    dots.count = k;
    dots.instanceMatrix.needsUpdate = true;
    ring.current.position.copy(pred.point).addScaledVector(pred.normal, 0.06);
    ring.current.quaternion.setFromUnitVectors(_ts.set(0, 0, 1), pred.normal);
    (ring.current.material as THREE.MeshBasicMaterial).color.set(QUALITY_COLOR[pred.predictedQuality]);
  });
  return (
    <>
      <primitive object={dots} />
      <mesh ref={ring} visible={false}>
        <ringGeometry args={[1.5, 1.9, 48]} />
        <meshBasicMaterial transparent opacity={0.9} toneMapped={false} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
    </>
  );
}

/* ================================================================== */
/* Chase camera                                                        */
/* ================================================================== */

const WORLD_UP = new THREE.Vector3(0, 1, 0);

function ChaseCamera() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const st = useMemo(
    () => ({
      up: new THREE.Vector3(0, 1, 0),
      heading: new THREE.Vector3(0, 0, -1),
      offset: new THREE.Vector3(0, 3, 9),
      look: new THREE.Vector3(),
      tmp: new THREE.Vector3(),
      right: new THREE.Vector3(),
      desired: new THREE.Vector3(),
      origin: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      hit: createRayHit(),
      allowed: 30,
      init: false,
    }),
    [],
  );
  useEffect(() => {
    (window as unknown as { __viewer: Record<string, unknown> }).__viewer.cam = st;
  }, [st]);
  useFrame((_, delta) => {
    const dt = Math.min(0.1, delta);
    const v = controller.sim.snapshot.vehicle;
    const p = controller.pose.position;
    const grounded = v.groundedWheels >= 2 && !v.airborne;
    // up follows the driving surface on the ground, world up in the air
    const targetUp = grounded ? _ts.set(0, 1, 0).applyQuaternion(controller.pose.quaternion) : WORLD_UP;
    // rotate (not lerp) toward the target up: lerp + normalize stalls when the two are opposite
    // (e.g. leaving the inverted beam); the heading is the fallback axis ⇒ the camera rolls over
    const cosA = Math.max(-1, Math.min(1, st.up.dot(targetUp)));
    const angle = Math.acos(cosA);
    if (angle > 1e-4) {
      const axis = st.dir.crossVectors(st.up, targetUp);
      if (axis.lengthSq() < 1e-8) axis.copy(st.heading);
      axis.normalize();
      st.up.applyAxisAngle(axis, angle * (1 - Math.exp(-(grounded ? 7 : 3) * dt))).normalize();
    }
    // heading: chassis forward on the ground (in the surface plane); in the air the full 3D velocity, so
    // the camera trails behind/above the trajectory (clear of downhill terrain) and flips never spin it
    const ref = st.tmp;
    if (grounded) {
      // project on the actual surface plane (not the smoothed up) so "behind" follows slopes at once
      ref.set(0, 0, -1).applyQuaternion(controller.pose.quaternion);
      ref.addScaledVector(targetUp, -ref.dot(targetUp));
    } else if (v.speed > 3) ref.copy(v.velocity);
    else ref.copy(st.heading);
    if (ref.lengthSq() > 1e-4) st.heading.lerp(ref.normalize(), 1 - Math.exp(-(grounded ? 6 : 4) * dt)).normalize();
    const r = st.dir.crossVectors(st.heading, st.up);
    if (r.lengthSq() > 1e-4) st.right.copy(r.normalize());
    const mode = controller.camMode;
    if (mode === 'side') st.desired.copy(st.right).multiplyScalar(13).addScaledVector(st.up, 2.5).addScaledVector(st.heading, 2);
    else if (mode === 'high') st.desired.copy(st.heading).multiplyScalar(-20).addScaledVector(st.up, 14);
    // airborne: higher and further back so the landing zone and trajectory stay in view
    else if (grounded) st.desired.copy(st.heading).multiplyScalar(-8.5).addScaledVector(st.up, 2.9);
    else st.desired.copy(st.heading).multiplyScalar(-11).addScaledVector(st.up, 5.2);
    if (!st.init) {
      st.offset.copy(st.desired);
      st.init = true;
    }
    // offsets are smoothed in the car's frame: no lag at 80 m/s
    st.offset.lerp(st.desired, 1 - Math.exp(-6 * dt));
    // collision: never let the camera sink into slopes / slabs behind the car
    st.origin.copy(p).addScaledVector(st.up, 0.8);
    st.dir.copy(p).add(st.offset).sub(st.origin);
    const dist = st.dir.length();
    st.dir.divideScalar(Math.max(1e-6, dist));
    const hit = controller.sim.physics.raycast(st.origin, st.dir, dist, st.hit);
    // smoothed allowed distance: pull in fast, ease back out; never closer than 2.5 m
    const target = hit ? Math.max(2.5, hit.distance - 0.6) : dist;
    const rate = target < st.allowed ? 14 : 2.5;
    st.allowed += (target - st.allowed) * (1 - Math.exp(-rate * dt));
    camera.position.copy(st.origin).addScaledVector(st.dir, Math.min(dist, st.allowed));
    camera.up.copy(st.up);
    st.look.copy(p).addScaledVector(st.up, grounded ? 0.9 : -0.6).addScaledVector(st.heading, mode === 'chase' ? (grounded ? 3.5 : 7) : 0);
    camera.lookAt(st.look);
    const fov = 60 + 12 * Math.min(1, v.speed / 80);
    if (Math.abs(camera.fov - fov) > 0.05) {
      camera.fov += (fov - camera.fov) * (1 - Math.exp(-3 * dt));
      camera.updateProjectionMatrix();
    }
  }, -50);
  return null;
}

/* ================================================================== */
/* HUD (DOM, ~15 Hz via refs — never React state per frame)            */
/* ================================================================== */

function Hud() {
  const speed = useRef<HTMLSpanElement>(null!);
  const fuel = useRef<HTMLElement>(null!);
  const flags = useRef<HTMLDivElement>(null!);
  const objective = useRef<HTMLDivElement>(null!);
  const landing = useRef<HTMLDivElement>(null!);
  const log = useRef<HTMLDivElement>(null!);
  const prompt = useRef<HTMLDivElement>(null!);
  const banner = useRef<HTMLDivElement>(null!);
  const bannerSub = useRef<HTMLDivElement>(null!);
  const status = useRef<HTMLDivElement>(null!);
  const air = useRef<HTMLDivElement>(null!);

  useEffect(() => {
    let logKey = '';
    const id = window.setInterval(() => {
      const s = controller.sim.snapshot;
      const v = s.vehicle;
      speed.current.textContent = Math.round(v.speed * KMH).toString();
      fuel.current.style.width = `${(v.fuel * 100).toFixed(1)}%`;
      fuel.current.style.background = v.boosting ? PALETTE.orange : PALETTE.cyan;
      const vac = v.vacuum.available ? `VAC ${v.vacuum.mode.toUpperCase()} ${v.vacuum.mode === 'engaged' ? (v.vacuum.strength * 100).toFixed(0) + '%' : ''}` : 'VAC —';
      flags.current.innerHTML = [
        `<b class="${v.airborne ? 'on' : ''}">${v.airborne ? 'AIRBORNE' : 'GROUNDED'}</b>`,
        `${v.groundedWheels}/4 WHEELS`,
        `<b class="${v.vacuum.mode === 'engaged' ? 'on' : ''}">${vac}</b>`,
        v.stabilizing ? '<b class="on">STABILIZE</b>' : '',
        controller.autopilotOn ? '<b class="ap">AUTOPILOT</b>' : '',
      ]
        .filter(Boolean)
        .join('<i>·</i>');
      air.current.textContent = s.air.airborne
        ? `AIR ${s.air.airTime.toFixed(2)} s · ${s.air.height === Infinity ? '∞' : s.air.height.toFixed(1)} m · ${s.air.distance.toFixed(0)} m · P ${s.air.rotation.pitch.toFixed(0)}° Y ${s.air.rotation.yaw.toFixed(0)}° R ${s.air.rotation.roll.toFixed(0)}°${s.prediction ? ` · ALIGN ${s.prediction.alignmentDeg.toFixed(0)}° → ${s.prediction.predictedQuality.toUpperCase()}` : ''}`
        : `SCORE ${s.score.total} · JUMPS ${s.score.jumps} · T ${s.time.toFixed(1)} s`;
      const o = s.objective;
      objective.current.textContent = o.total ? `${o.complete ? '✓ ' : ''}${o.index + 1}/${o.total}  ${o.title} — ${o.text}` : '';
      const l = s.score.lastLanding;
      landing.current.innerHTML = l
        ? `LAST LANDING <b style="color:${QUALITY_COLOR[l.quality]}">${l.quality.toUpperCase()}</b> · ${l.angleDeg.toFixed(1)}° · ${l.impactSpeed.toFixed(1)} m/s · drift ${l.driftDeg.toFixed(0)}° · ${l.wheelsDown}w · +${l.points}`
        : 'LAST LANDING —';
      prompt.current.textContent = s.prompt?.text ?? '';
      prompt.current.style.opacity = s.prompt ? '1' : '0';
      const b = controller.banner;
      const showBanner = !!b && controller.realTime < b.until;
      banner.current.style.opacity = showBanner ? '1' : '0';
      if (b && showBanner) {
        banner.current.firstChild!.textContent = b.text;
        banner.current.style.color = b.color;
        bannerSub.current.textContent = b.sub;
      }
      status.current.textContent = controller.paused ? 'PAUSED' : s.timeScale < 1 ? `SLOW-MO ×${s.timeScale.toFixed(2)}` : '';
      const key = controller.log.map((x) => x.t + x.text).join('|');
      if (key !== logKey) {
        logKey = key;
        log.current.innerHTML = controller.log
          .slice(-9)
          .map((x) => `<div style="color:${x.color ?? PALETTE.titanium200}"><span>${x.t.toFixed(2).padStart(6, ' ')}</span>${x.text}</div>`)
          .join('');
      }
    }, 66);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="pv-hud">
      <style>{HUD_CSS}</style>
      <div className="pv-panel pv-main">
        <div className="pv-kicker">ROADSTER FLIGHT · PHYSICS</div>
        <div className="pv-level">{controller.level.name}</div>
        <div className="pv-speed">
          <span ref={speed}>0</span>
          <small>km/h</small>
        </div>
        <div className="pv-fuel">
          <i ref={fuel} />
        </div>
        <div className="pv-flags" ref={flags} />
        <div className="pv-air" ref={air} />
        <div className="pv-objective" ref={objective} />
        <div className="pv-landing" ref={landing} />
      </div>
      <div className="pv-panel pv-log" ref={log} />
      <div className="pv-help pv-panel">
        <div><kbd>W</kbd><kbd>S</kbd> throttle · pitch</div>
        <div><kbd>A</kbd><kbd>D</kbd> steer · yaw &nbsp;<kbd>Q</kbd><kbd>E</kbd> roll</div>
        <div><kbd>SPACE</kbd> thrust &nbsp;<kbd>SHIFT</kbd> stabilize</div>
        <div><kbd>ENTER</kbd> vacuum &nbsp;<kbd>R</kbd> restart &nbsp;<kbd>P</kbd> pause</div>
        <div><kbd>T</kbd> autopilot &nbsp;<kbd>C</kbd> camera &nbsp;<kbd>G</kbd> contacts</div>
        <div className="pv-levels">
          {(['flat', 'ramp', 'vacuum'] as const).map((k) => (
            <a key={k} href={`?level=${k}`} className={k === LEVEL_KEY ? 'on' : ''}>
              {k}
            </a>
          ))}
        </div>
      </div>
      <div className="pv-prompt" ref={prompt} />
      <div className="pv-banner" ref={banner}>
        <span />
        <div ref={bannerSub} />
      </div>
      <div className="pv-status" ref={status} />
    </div>
  );
}

const HUD_CSS = `
.pv-hud { position: fixed; inset: 0; pointer-events: none; font-family: var(--font-ui); color: var(--warm-white); }
.pv-panel { position: absolute; background: rgba(18,20,23,0.62); border: 1px solid rgba(163,170,178,0.18); border-radius: 10px;
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); padding: 14px 16px; }
.pv-main { left: 20px; top: 20px; width: 430px; }
.pv-kicker { font-family: var(--font-display); font-size: 9px; letter-spacing: 0.32em; color: var(--titanium-300); }
.pv-level { font-family: var(--font-display); font-size: 15px; letter-spacing: 0.18em; margin: 6px 0 8px; }
.pv-speed { font-family: var(--font-mono); font-weight: 600; font-size: 46px; line-height: 1; letter-spacing: -0.02em; }
.pv-speed small { font-size: 12px; font-weight: 400; margin-left: 8px; color: var(--titanium-300); letter-spacing: 0.1em; }
.pv-fuel { height: 4px; background: rgba(163,170,178,0.18); border-radius: 2px; margin: 10px 0 10px; overflow: hidden; }
.pv-fuel i { display: block; height: 100%; width: 100%; background: var(--cyan); transition: width 60ms linear; }
.pv-flags { font-family: var(--font-mono); font-size: 11px; color: var(--titanium-300); letter-spacing: 0.04em; }
.pv-flags b { font-weight: 600; color: var(--titanium-200); }
.pv-flags b.on { color: var(--cyan); }
.pv-flags b.ap { color: var(--amber); }
.pv-flags i { font-style: normal; margin: 0 7px; opacity: 0.4; }
.pv-air { font-family: var(--font-mono); font-size: 11px; color: var(--titanium-200); margin-top: 6px; min-height: 14px; }
.pv-objective { font-size: 12px; margin-top: 10px; color: var(--warm-white); }
.pv-landing { font-family: var(--font-mono); font-size: 11px; margin-top: 6px; color: var(--titanium-300); }
.pv-landing b { font-weight: 600; }
.pv-log { left: 20px; bottom: 20px; width: 430px; font-family: var(--font-mono); font-size: 11px; line-height: 1.6; min-height: 40px; }
.pv-log span { color: var(--titanium-400); margin-right: 10px; white-space: pre; }
.pv-help { right: 20px; top: 20px; font-size: 11px; line-height: 2; color: var(--titanium-300); }
.pv-help kbd { font-family: var(--font-mono); font-size: 10px; color: var(--warm-white); border: 1px solid rgba(163,170,178,0.35);
  border-radius: 4px; padding: 1px 5px; margin-right: 3px; background: rgba(255,255,255,0.04); }
.pv-levels { margin-top: 6px; pointer-events: auto; display: flex; gap: 6px; }
.pv-levels a { font-family: var(--font-display); font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--titanium-300);
  text-decoration: none; border: 1px solid rgba(163,170,178,0.25); border-radius: 4px; padding: 3px 8px; }
.pv-levels a.on { color: var(--graphite-900); background: var(--cyan); border-color: var(--cyan); }
.pv-prompt { position: absolute; left: 50%; top: 22%; transform: translateX(-50%); font-family: var(--font-display); font-size: 22px;
  letter-spacing: 0.22em; color: var(--cyan); text-shadow: 0 0 24px rgba(56,232,255,0.45); transition: opacity 120ms; white-space: nowrap; }
.pv-banner { position: absolute; left: 50%; top: 34%; transform: translateX(-50%); text-align: center; transition: opacity 200ms; opacity: 0; }
.pv-banner span { font-family: var(--font-display); font-size: 44px; letter-spacing: 0.3em; text-shadow: 0 0 30px currentColor; }
.pv-banner div { font-family: var(--font-mono); font-size: 13px; color: var(--warm-white); margin-top: 8px; letter-spacing: 0.06em; }
.pv-status { position: absolute; right: 24px; bottom: 22px; font-family: var(--font-display); font-size: 11px; letter-spacing: 0.3em; color: var(--amber); }
`;

/* ================================================================== */
/* App                                                                 */
/* ================================================================== */

function ShotReady() {
  const frames = useRef(0);
  const scene = useThree((st) => st.scene);
  useEffect(() => {
    (window as unknown as { __viewer: Record<string, unknown> }).__viewer.scene = scene;
  }, [scene]);
  useFrame(() => {
    frames.current++;
    if (frames.current === 20) (window as unknown as { __shotReady: boolean }).__shotReady = true;
  });
  return null;
}

function App() {
  useKeyboard();
  return (
    <>
      <Canvas
        shadows="percentage"
        dpr={[1, 1.5]}
        gl={{ antialias: true, powerPreference: 'high-performance', stencil: false }}
        camera={{ position: [0, 4, 12], fov: 60, near: 0.1, far: 8000 }}
        style={{ position: 'fixed', inset: 0 }}
      >
        <SimDriver />
        <ChaseCamera />
        <Environment />
        <LevelMeshes />
        <Car />
        <Prediction />
        <ShotReady />
      </Canvas>
      <Hud />
    </>
  );
}

async function main(): Promise<void> {
  await initPhysics();
  controller = new ViewerController();
  const w = window as unknown as { __sim: GameSim; __viewer: unknown };
  Object.defineProperty(window, '__sim', { get: () => controller.sim, configurable: true });
  w.__viewer = {
    controller,
    reset: () => controller.reset(),
    autopilot: (on: boolean) => controller.setAutopilot(on),
    camera: (mode: CamMode) => (controller.camMode = mode),
    pause: (on: boolean) => (controller.paused = on),
  };
  createRoot(document.getElementById('root')!).render(<App />);
}

void main();
