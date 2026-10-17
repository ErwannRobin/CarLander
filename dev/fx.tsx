/**
 * FX sandbox — http://127.0.0.1:5173/dev/fx.html
 *
 * Mirrors the production look so tuning done here transfers to the game: theme lighting numbers are
 * copied from src/render/env/themes.ts (key light, hemisphere, environment intensity, fog, exposure,
 * bloom, vignette, AgX look) and the post chain follows src/render/post/PostFX.tsx (bloom on the HDR
 * input -> vignette -> exposure + AgX). Nothing outside the FX module + shared foundation is imported.
 *
 * Drivers
 *   ?mode=mock (default)  the shared mock timeline (src/dev/mockRuntime.ts, 12.5 s loop): accelerate,
 *                         jump + boost + backflip, landing, vacuum, drift, crash
 *   ?mode=manual          a car moving straight at ?v= m/s, ?alt= m above the ground (?vy= vertical
 *                         speed), attitude ?pitch= ?roll= ?yaw= (deg)
 *   ?driver=hook          mock timeline through useMockRuntime() itself (no fixed-step replay / freeze)
 *
 * Screenshot helpers
 *   ?freeze=<s>     (mock) replay the timeline up to <s> with a fixed 60 Hz step, then freeze everything
 *   ?lead=<s>       seconds of timeline replayed before the freeze point (default 2.5)
 *   ?fx=<name>      auto-trigger: perfect | clean | hard | crash | sparks | slam | fuel | ignite  (one-shot, at ?at= s;
 *                                 fuel starts boosting first, then runs dry)
 *                                 boost | vacuum | drift | rcs   (on from the start; ?rcs=1..5 picks the pattern)
 *                                 stress                         (everything at once, for --fps)
 *   ?hold=<s>       freeze <s> seconds after the auto-trigger (or after the start)
 *   ?bl=<0..1>      boost level reached by the boost toggle (default 1)
 *   ?rcsmag=<0..1>  magnitude of the RCS test command (the stabilizer's slow roll reports ~0.1–0.2)
 *   ?cam=game|chase|high|rear|side|quarter|front|low|top|orbit   ?dist=<scale>  ?fov=<deg>  ?shift=<m>
 *   ?lag=<s>        extra camera distance = speed * lag (production rig smoothing; default 0.11 for cam=game)
 *   ?theme=morning|canyon|night   ?surface=asphalt|concrete   ?q=low|medium|high   ?ui=0
 *   ?only=exhaust,rcs,smoke,landing,impact,vacuum,speed,marker,arc   isolate effects
 *
 * Keys: 1 perfect · 2 clean · 3 hard · 4 crash · 5 sparks · 6 slam · B boost · V vacuum · T rcs
 *       D drift · F fuel empty · P pause · C camera · arrows: pitch / roll (manual mode)
 */
import { createRoot } from 'react-dom/client';
import { useFrame, useThree } from '@react-three/fiber';
import { Environment, Lightformer, OrbitControls, RoundedBox } from '@react-three/drei';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import { BlendFunction, Effect } from 'postprocessing';
import { type CSSProperties, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  BackSide,
  CanvasTexture,
  ClampToEdgeWrapping,
  Color,
  type DirectionalLight,
  FogExp2,
  type Group,
  HalfFloatType,
  type Mesh,
  PCFShadowMap,
  type PerspectiveCamera,
  Quaternion,
  RepeatWrapping,
  ShaderMaterial,
  SRGBColorSpace,
  Uniform,
  Vector3,
} from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import '@/styles/base.css';
import { QUALITY_PRESETS } from '@/config/quality';
import { DevCanvas } from '@/dev/DevCanvas';
import { MockSim, useMockRuntime } from '@/dev/mockRuntime';
import { CAMERA_PRIORITY, runtime, RUNTIME_FRAME_PRIORITY } from '@/game/runtime';
import { createSnapshot } from '@/game/snapshot';
import type { GameEvent, LandingQuality, LandingResult, SimSnapshot, ThemeId } from '@/game/types';
import { NOZZLES, VEHICLE, WHEEL_POSITIONS } from '@/game/vehicleSpec';
import {
  FXProvider,
  type FXSystem,
  GameFX,
  ImpactFX,
  LandingFX,
  LandingMarker,
  RcsJets,
  RocketExhaust,
  SpeedLines,
  TireSmoke,
  TrajectoryArc,
  useFX,
  VacuumFX,
} from '@/render/fx';
import { PALETTE } from '@/render/palette';

/* ------------------------------------------------------------------------------------------ */
/* Params                                                                                       */
/* ------------------------------------------------------------------------------------------ */

const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => (params.has(k) ? Number(params.get(k)) : d);
const MODE = params.get('mode') === 'manual' ? 'manual' : 'mock';
const HOOK_DRIVER = MODE === 'mock' && params.get('driver') === 'hook';
const FREEZE = params.has('freeze') && !HOOK_DRIVER ? Number(params.get('freeze')) : undefined;
const LEAD = num('lead', 2.5);
const FX = params.get('fx') ?? '';
const AT = num('at', 0.6);
const HOLD = params.has('hold') ? Number(params.get('hold')) : undefined;
const CAMS = ['game', 'chase', 'high', 'rear', 'side', 'quarter', 'front', 'low', 'top', 'orbit'] as const;
type CamMode = (typeof CAMS)[number];
const CAM0 = (CAMS as readonly string[]).includes(params.get('cam') ?? '') ? (params.get('cam') as CamMode) : 'chase';
const DIST = num('dist', 1);
/**
 * ?lag=<s> — extra camera distance = speed * lag, emulating the production rig's position smoothing
 * (smoothDamp 0.11 s on the ground lags ~8 m behind at 75 m/s). Default 0.11 for cam=game.
 */
const LAG = num('lag', params.get('cam') === 'game' ? 0.11 : 0);
/** Slides the whole framing along the car heading (m, negative = behind the car), e.g. to frame the plume. */
const SHIFT = num('shift', 0);
const FOV = num('fov', 62);
const QUALITY = (['low', 'medium', 'high'] as const).find((q) => q === params.get('q')) ?? 'high';
const SHOW_UI = params.get('ui') !== '0';
/** ?only=exhaust,rcs,smoke,landing,impact,vacuum,speed,marker,arc — isolate effects (debug / screenshots). */
const ONLY = params.get('only')?.split(',').map((s) => s.trim()) ?? null;
const STRESS = FX === 'stress';
const MANUAL_V = num('v', STRESS ? 72 : 30);
const MANUAL_ALT = num('alt', 0);
const MANUAL_VY = num('vy', MANUAL_ALT > 0 ? -5 : 0);
const BOOST_LEVEL = Math.min(1, Math.max(0, num('bl', 1)));
/** ?rcsmag=<0..1> — magnitude of the RCS test command (the stabilizer's slow roll reports ~0.1–0.2). */
const RCS_MAG = Math.min(1, Math.max(0, num('rcsmag', 1)));
const CONCRETE = params.get('surface') === 'concrete';
/** ?atlas=1 — debug view of the procedural sprite atlas (R glow, G puff density, BA puff normal). */
const ATLAS = params.get('atlas') === '1';
const FIXED_STEP = FREEZE !== undefined || HOLD !== undefined;
const DEG = Math.PI / 180;
const RIDE = -VEHICLE.groundY;
const G = 14;

/* ------------------------------------------------------------------------------------------ */
/* Theme presets — numbers copied from src/render/env/themes.ts (kept in sync by hand)          */
/* ------------------------------------------------------------------------------------------ */

interface SandboxTheme {
  id: ThemeId;
  sky: { zenith: string; horizon: string; haze: string };
  /** Shadow-casting key light (sun, or the night moonlight). */
  key: { elevationDeg: number; azimuthDeg: number; color: string; intensity: number };
  hemi: { sky: string; ground: string; intensity: number };
  /** scene.environmentIntensity + studio cards of the reflection environment. */
  env: { intensity: number; cards: { elevationDeg: number; azimuthDeg: number; size: [number, number]; color: string; intensity: number }[] };
  fog: { color: string; density: number };
  exposure: number;
  bloom: { intensity: number; threshold: number; smoothing: number; radius: number };
  vignette: { offset: number; darkness: number };
  /** AgX look (ASC-CDL in AgX log space). */
  look: { slope: [number, number, number]; power: number; saturation: number };
  concrete: string;
  asphalt: string;
}

const THEMES: Record<'morning' | 'canyon' | 'night', SandboxTheme> = {
  morning: {
    id: 'morning',
    sky: { zenith: '#4a82cc', horizon: '#a6c4e6', haze: '#dcdfe2' },
    key: { elevationDeg: 25, azimuthDeg: -128, color: '#fff1de', intensity: 8.5 },
    hemi: { sky: '#cfe0f5', ground: '#e8e2d8', intensity: 0.12 },
    env: {
      intensity: 0.62,
      cards: [
        { elevationDeg: 62, azimuthDeg: 160, size: [60, 9], color: '#ffffff', intensity: 1.4 },
        { elevationDeg: 12, azimuthDeg: 95, size: [50, 4], color: '#fff6ea', intensity: 1.1 },
        { elevationDeg: 10, azimuthDeg: -110, size: [40, 3], color: '#e8f2ff', intensity: 0.8 },
      ],
    },
    fog: { color: '#d9dfe6', density: 0.00013 },
    exposure: 0.82,
    bloom: { intensity: 0.55, threshold: 1.3, smoothing: 0.25, radius: 0.72 },
    vignette: { offset: 0.34, darkness: 0.4 },
    look: { slope: [1, 1, 1], power: 1.12, saturation: 1.2 },
    concrete: PALETTE.concrete,
    asphalt: '#2b2e33',
  },
  canyon: {
    id: 'canyon',
    sky: { zenith: '#22529e', horizon: '#9fb5d0', haze: '#c0bcc2' },
    key: { elevationDeg: 10, azimuthDeg: 72, color: '#ffbd74', intensity: 7.2 },
    hemi: { sky: '#86a2cc', ground: '#8f6048', intensity: 0.16 },
    env: {
      intensity: 0.72,
      cards: [
        { elevationDeg: 58, azimuthDeg: -150, size: [55, 7], color: '#dfe8ff', intensity: 0.9 },
        { elevationDeg: 8, azimuthDeg: -100, size: [50, 3], color: '#ffcf9a', intensity: 0.8 },
      ],
    },
    fog: { color: '#bfbac0', density: 0.00015 },
    exposure: 1.02,
    bloom: { intensity: 0.6, threshold: 1.1, smoothing: 0.25, radius: 0.75 },
    vignette: { offset: 0.3, darkness: 0.48 },
    look: { slope: [1.03, 1.0, 0.96], power: 1.18, saturation: 1.25 },
    concrete: '#b3a89c',
    asphalt: '#2a2c30',
  },
  night: {
    id: 'night',
    sky: { zenith: '#030814', horizon: '#0f1b36', haze: '#141f38' },
    key: { elevationDeg: 40, azimuthDeg: 145, color: '#9fb8ff', intensity: 0.3 },
    hemi: { sky: '#1a2b52', ground: '#07090f', intensity: 0.12 },
    env: {
      intensity: 0.28,
      cards: [
        { elevationDeg: 22, azimuthDeg: -35, size: [3.2, 1.2], color: '#f4f7ff', intensity: 7 },
        { elevationDeg: 24, azimuthDeg: 40, size: [3.2, 1.2], color: '#f4f7ff', intensity: 6 },
        { elevationDeg: 18, azimuthDeg: 150, size: [3.6, 1.2], color: '#f4f7ff', intensity: 5 },
        { elevationDeg: 70, azimuthDeg: 0, size: [36, 5], color: '#24365e', intensity: 0.8 },
      ],
    },
    fog: { color: '#0c1322', density: 0.00016 },
    exposure: 1.2,
    bloom: { intensity: 0.9, threshold: 0.85, smoothing: 0.3, radius: 0.8 },
    vignette: { offset: 0.28, darkness: 0.55 },
    look: { slope: [0.98, 1.0, 1.04], power: 1.08, saturation: 1.08 },
    concrete: '#8f8c88',
    asphalt: '#26282c',
  },
};

const THEME_KEY = (() => {
  const t = params.get('theme');
  if (t === 'night') return 'night' as const;
  if (t === 'canyon') return 'canyon' as const;
  return 'morning' as const; // 'day' kept as an alias of morning
})();
const THEME = THEMES[THEME_KEY];

/** Unit direction toward (elevation, azimuth) — same convention as the env module (0 = toward -Z, +90 = +X). */
function dirFromAngles(elevationDeg: number, azimuthDeg: number, out = new Vector3()): Vector3 {
  const el = elevationDeg * DEG;
  const az = azimuthDeg * DEG;
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

runtime.quality = QUALITY_PRESETS[QUALITY];
runtime.level = null;

/* ------------------------------------------------------------------------------------------ */
/* Sandbox control store (UI <-> driver)                                                        */
/* ------------------------------------------------------------------------------------------ */

const ctl = {
  boost: FX === 'boost' || FX === 'fuel' || STRESS, // 'fuel' cuts a running boost
  vacuum: FX === 'vacuum' || STRESS,
  drift: FX === 'drift' || STRESS,
  rcs: FX === 'rcs' ? num('rcs', 5) : STRESS ? 5 : 0,
  paused: false,
  cam: CAM0 as CamMode,
  pitch: num('pitch', 0),
  roll: num('roll', 0),
  yaw: num('yaw', 0),
  pending: [] as string[],
  version: 0,
};
const listeners = new Set<() => void>();
function setCtl(patch: Partial<typeof ctl>) {
  Object.assign(ctl, patch);
  ctl.version++;
  listeners.forEach((l) => l());
}
function useCtl() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => ctl.version,
  );
}
const RCS_LABELS = ['off', 'pitch up', 'pitch down', 'yaw left', 'roll right', 'sweep'];

function markReady() {
  (window as unknown as { __shotReady: boolean }).__shotReady = true;
}

/* ------------------------------------------------------------------------------------------ */
/* Manual car + overrides + event triggers                                                      */
/* ------------------------------------------------------------------------------------------ */

const _q = new Quaternion();
const _q2 = new Quaternion();
const _v = new Vector3();
const _up = new Vector3(0, 1, 0);

function setPose(snap: SimSnapshot, pos: Vector3, yaw: number, pitch: number, roll: number) {
  const v = snap.vehicle;
  v.position.copy(pos);
  v.quaternion.setFromAxisAngle(_up, yaw);
  v.quaternion.multiply(_q.setFromAxisAngle(_v.set(1, 0, 0), pitch));
  v.quaternion.multiply(_q2.setFromAxisAngle(_v.set(0, 0, -1), roll));
  v.forward.set(0, 0, -1).applyQuaternion(v.quaternion);
  v.up.set(0, 1, 0).applyQuaternion(v.quaternion);
  v.right.set(1, 0, 0).applyQuaternion(v.quaternion);
}

/** A car moving straight on (or above) the ground plane, attitude from the control store. */
class ManualCar {
  snapshot = createSnapshot(3);
  pos = new Vector3(0, RIDE + MANUAL_ALT, 0);
  constructor() {
    this.snapshot.phase = 'running';
    this.snapshot.vehicle.vacuum.available = true;
  }
  update(dt: number) {
    const s = this.snapshot;
    const v = s.vehicle;
    const yaw = ctl.yaw * DEG;
    const speed = MANUAL_V;
    _v.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    this.pos.addScaledVector(_v, speed * dt);
    this.pos.y = RIDE + MANUAL_ALT;
    setPose(s, this.pos, yaw, ctl.pitch * DEG, ctl.roll * DEG);
    v.velocity.copy(_v).multiplyScalar(speed);
    v.velocity.y = MANUAL_VY;
    v.speed = v.velocity.length();
    v.forwardSpeed = speed;
    const grounded = MANUAL_ALT < 0.01;
    v.wheels.forEach((w, i) => {
      w.grounded = grounded;
      const [x, , z] = WHEEL_POSITIONS[i];
      w.contactPoint.set(x, -RIDE, z).applyQuaternion(v.quaternion).add(v.position);
      if (grounded) w.contactPoint.y = 0;
      w.contactNormal.set(0, 1, 0);
      w.spinRate = speed / VEHICLE.wheelRadius;
      w.spinAngle += w.spinRate * dt;
      w.suspensionLength = VEHICLE.suspension.hardpointY;
      w.slip = 0;
      w.surface = grounded ? 'asphalt' : null;
    });
    v.groundedWheels = grounded ? 4 : 0;
    v.airborne = !grounded;
    s.air.airborne = !grounded;
    s.air.height = MANUAL_ALT;
    // boost / vacuum levels are owned by Overrides (toggles); RCS is re-commanded every frame
    v.rcs.pitch = v.rcs.yaw = v.rcs.roll = 0;
    // ballistic prediction to y = 0 (sandbox only: allocations are fine here)
    if (!grounded) {
      const h = MANUAL_ALT;
      const vy = MANUAL_VY;
      const tLand = (vy + Math.sqrt(vy * vy + 2 * G * h)) / G;
      const path: Vector3[] = [];
      for (let i = 0; i <= 32; i++) {
        const t = (tLand * i) / 32;
        path.push(new Vector3(this.pos.x + v.velocity.x * t, Math.max(RIDE, this.pos.y + vy * t - 0.5 * G * t * t), this.pos.z + v.velocity.z * t));
      }
      const align = (Math.acos(Math.min(1, Math.max(-1, v.up.y))) * 180) / Math.PI;
      const q: LandingQuality = align <= 9 ? 'perfect' : align <= 24 ? 'clean' : align <= 50 ? 'hard' : 'crash';
      s.prediction = {
        valid: true,
        point: path[path.length - 1].clone().setY(0),
        normal: new Vector3(0, 1, 0),
        timeToImpact: tLand,
        alignmentDeg: align,
        pitchErrorDeg: ctl.pitch,
        rollErrorDeg: ctl.roll,
        predictedQuality: q,
        inTarget: true,
        path,
      };
    } else {
      s.prediction = null;
    }
    s.time += dt;
    s.tick++;
  }
}

/**
 * Applies UI toggles on top of whichever driver produced the snapshot. `owns` = the driver does not
 * animate boost / vacuum itself (manual car), so released toggles must also ramp the levels down.
 */
class Overrides {
  private boostOn = false;
  private vacOn = false;
  apply(snap: SimSnapshot, dt: number, t: number, events: GameEvent[], owns = false) {
    const v = snap.vehicle;
    if (ctl.boost) {
      if (!this.boostOn) events.push({ type: 'boostStart' });
      v.boosting = true;
      v.boostLevel += (BOOST_LEVEL - v.boostLevel) * Math.min(1, dt * 10);
    } else {
      if (this.boostOn) {
        events.push({ type: 'boostEnd' });
        v.boosting = false;
      }
      if (owns) v.boostLevel += (0 - v.boostLevel) * Math.min(1, dt * 5);
    }
    this.boostOn = ctl.boost;

    const vac = v.vacuum;
    if (ctl.vacuum) {
      if (!this.vacOn) {
        events.push({ type: 'vacuumOn' });
        events.push({ type: 'vacuumEngaged', position: v.position.clone(), normal: new Vector3(0, 1, 0) });
      }
      vac.available = true;
      vac.mode = 'engaged';
      vac.strength += (1 - vac.strength) * Math.min(1, dt * 8);
      vac.hasSurface = true;
      vac.distance = Math.max(0.12, v.position.y - RIDE + 0.12);
      vac.surfacePoint.set(v.position.x, 0, v.position.z);
      vac.surfaceNormal.set(0, 1, 0);
    } else {
      if (this.vacOn) {
        events.push({ type: 'vacuumReleased', position: v.position.clone() });
        events.push({ type: 'vacuumOff' });
        vac.mode = 'off';
      }
      if (owns) {
        vac.mode = 'off';
        vac.hasSurface = false;
        vac.distance = Infinity;
        vac.strength += (0 - vac.strength) * Math.min(1, dt * 14);
      }
    }
    this.vacOn = ctl.vacuum;

    if (ctl.rcs > 0) {
      const sweep = Math.floor(t / 1.2) % 4;
      const pat = ctl.rcs === 5 ? sweep + 1 : ctl.rcs;
      v.rcs.pitch = (pat === 1 ? 1 : pat === 2 ? -1 : 0) * RCS_MAG;
      v.rcs.yaw = (pat === 3 ? 1 : 0) * RCS_MAG;
      v.rcs.roll = (pat === 4 ? 1 : 0) * RCS_MAG;
    }
    if (ctl.drift) {
      for (const w of v.wheels) if (w.grounded) w.slip = 0.85;
    }
  }
}

function landingResult(snap: SimSnapshot, quality: LandingQuality, impact: number): LandingResult {
  return {
    quality,
    angleDeg: quality === 'perfect' ? 3 : quality === 'clean' ? 14 : 38,
    impactSpeed: impact,
    driftDeg: 2,
    wheelsDown: 4,
    airTime: 3,
    distance: 120,
    maxHeight: 14,
    tricks: [],
    basePoints: 1000,
    multiplier: 2,
    points: 2000,
    inTarget: true,
    position: snap.vehicle.position.clone(),
  };
}

function triggerEvents(name: string, snap: SimSnapshot, events: GameEvent[]) {
  const p = snap.vehicle.position.clone().setY(0);
  switch (name) {
    case 'perfect':
      events.push({ type: 'landing', result: landingResult(snap, 'perfect', 5) });
      events.push({ type: 'wheelSlam', position: p, strength: 0.35 });
      break;
    case 'clean':
      events.push({ type: 'landing', result: landingResult(snap, 'clean', 10) });
      events.push({ type: 'wheelSlam', position: p, strength: 0.6 });
      break;
    case 'hard':
      events.push({ type: 'landing', result: landingResult(snap, 'hard', 20) });
      events.push({ type: 'wheelSlam', position: p, strength: 0.95 });
      break;
    case 'slam':
      events.push({ type: 'wheelSlam', position: p, strength: 0.8 });
      break;
    case 'crash':
      events.push({ type: 'impact', position: p.clone().setY(0.15), normal: new Vector3(0, 1, 0), strength: 1 });
      events.push({ type: 'crash', reason: 'impact', position: snap.vehicle.position.clone(), impactSpeed: 24 });
      break;
    case 'sparks': {
      const side = Math.random() < 0.5 ? -1 : 1;
      const q = snap.vehicle.position.clone().add(new Vector3(side * 0.9, 0, 0.6).applyQuaternion(snap.vehicle.quaternion)).setY(0.05);
      events.push({ type: 'impact', position: q, normal: new Vector3(0, 1, 0), strength: 0.5 + Math.random() * 0.5 });
      break;
    }
    case 'fuel':
      setCtl({ boost: false });
      events.push({ type: 'fuelEmpty' });
      break;
    case 'ignite':
      events.push({ type: 'boostStart' });
      break;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Drivers (runtime.frame publishers)                                                           */
/* ------------------------------------------------------------------------------------------ */

/** Renderer stats of the previous frame (gl.info is reset manually once per frame by the driver). */
const lastInfo = { calls: 0, triangles: 0 };

/**
 * Default driver: MockSim (the engine behind useMockRuntime) or the manual car, with overrides,
 * triggers, a fixed-step lead-in replay and a freeze for faithful screenshots.
 */
function SandboxDriver() {
  const gl = useThree((s) => s.gl);
  const drv = useMemo(
    () => ({
      mock: new MockSim({}),
      manual: new ManualCar(),
      overrides: new Overrides(),
      t: 0,
      started: false,
      frozen: false,
      frames: 0,
      triggered: false,
      triggerT: FX && !['boost', 'vacuum', 'drift', 'rcs', 'stress'].includes(FX) ? AT : 0,
      stressNext: 1,
    }),
    [],
  );

  useEffect(() => {
    gl.info.autoReset = false;
  }, [gl]);

  useFrame((state, delta) => {
    lastInfo.calls = gl.info.render.calls;
    lastInfo.triangles = gl.info.render.triangles;
    gl.info.reset();
    const f = runtime.frame;
    drv.frames++;
    if (drv.frozen || ctl.paused) {
      f.paused = true;
      f.dt = 0;
      f.simDt = 0;
      f.time = state.clock.elapsedTime;
      return;
    }
    const dt = FIXED_STEP ? 1 / 60 : Math.min(0.1, delta);
    const events: GameEvent[] = [];
    let snap: SimSnapshot;
    if (MODE === 'mock') {
      if (!drv.started && FREEZE !== undefined) {
        const skip = Math.max(0, FREEZE - LEAD);
        if (skip > 0) events.push(...drv.mock.update(skip));
        drv.t = skip;
      }
      events.push(...drv.mock.update(dt));
      snap = drv.mock.snapshot;
    } else {
      drv.manual.update(dt);
      snap = drv.manual.snapshot;
    }
    drv.started = true;
    drv.t += dt;
    drv.overrides.apply(snap, dt, drv.t, events, MODE === 'manual');

    // one-shot auto trigger
    if (FX && !drv.triggered && drv.t >= drv.triggerT) {
      drv.triggered = true;
      triggerEvents(FX, snap, events);
    }
    // stress: periodic bursts
    if (STRESS && drv.t >= drv.stressNext) {
      drv.stressNext += 0.7;
      const pick = ['sparks', 'perfect', 'hard', 'crash', 'sparks'][Math.floor(Math.random() * 5)];
      triggerEvents(pick, snap, events);
    }
    for (const name of ctl.pending) triggerEvents(name, snap, events);
    ctl.pending.length = 0;

    f.snapshot = snap;
    f.position.copy(snap.vehicle.position);
    f.quaternion.copy(snap.vehicle.quaternion);
    f.alpha = 1;
    f.dt = dt;
    f.simDt = dt;
    f.time = state.clock.elapsedTime;
    f.paused = false;
    for (const e of events) runtime.events.emit(e);

    // freeze / ready logic
    if (FREEZE !== undefined && MODE === 'mock' && drv.t >= FREEZE) {
      drv.frozen = true;
      markReady();
    } else if (HOLD !== undefined && drv.t >= drv.triggerT + HOLD) {
      drv.frozen = true;
      markReady();
    } else if (FREEZE === undefined && HOLD === undefined && drv.frames === 30) {
      markReady();
    }
  }, RUNTIME_FRAME_PRIORITY);
  return null;
}

/**
 * `?driver=hook`: the shared useMockRuntime() hook publishes the frame; toggles / triggers are layered
 * on top right after it (priority RUNTIME_FRAME_PRIORITY + 1, still before the camera and the FX).
 */
function HookDriver() {
  const gl = useThree((s) => s.gl);
  useMockRuntime();
  const st = useMemo(() => ({ overrides: new Overrides(), t: 0, frames: 0, triggered: false }), []);
  useEffect(() => {
    gl.info.autoReset = false;
  }, [gl]);
  useFrame(() => {
    lastInfo.calls = gl.info.render.calls;
    lastInfo.triangles = gl.info.render.triangles;
    gl.info.reset();
    const f = runtime.frame;
    st.frames++;
    st.t += f.dt;
    const events: GameEvent[] = [];
    st.overrides.apply(f.snapshot, f.dt, st.t, events);
    if (FX && !st.triggered && st.t >= AT) {
      st.triggered = true;
      triggerEvents(FX, f.snapshot, events);
    }
    for (const name of ctl.pending) triggerEvents(name, f.snapshot, events);
    ctl.pending.length = 0;
    for (const e of events) runtime.events.emit(e);
    if (st.frames === 30) markReady();
  }, RUNTIME_FRAME_PRIORITY + 1);
  return null;
}

/* ------------------------------------------------------------------------------------------ */
/* Camera rig                                                                                   */
/* ------------------------------------------------------------------------------------------ */

const _heading = new Vector3();
const _right = new Vector3();
const _target = new Vector3();
const _camPos = new Vector3();
const _prevCar = new Vector3();

function smooth01(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function CameraRig() {
  useCtl();
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const orbit = useRef<OrbitControlsImpl>(null);
  useFrame(() => {
    const f = runtime.frame;
    const v = f.snapshot.vehicle;
    const c = f.position;
    _heading.copy(v.velocity).setY(0);
    if (_heading.lengthSq() < 1) _heading.set(0, 0, -1).applyQuaternion(f.quaternion).setY(0);
    if (_heading.lengthSq() < 1e-4) _heading.set(0, 0, -1);
    _heading.normalize();
    _right.crossVectors(_heading, _up).normalize();
    const d = DIST;
    let fov = FOV;
    const set = (back: number, up: number, side: number, lookFwd: number, lookUp: number) => {
      const lag = v.speed * LAG;
      _camPos.copy(c).addScaledVector(_heading, SHIFT - back * d - lag).addScaledVector(_up, up * d).addScaledVector(_right, side * d);
      _target.copy(c).addScaledVector(_heading, SHIFT + lookFwd).addScaledVector(_up, lookUp);
      camera.position.copy(_camPos);
      camera.lookAt(_target);
    };
    switch (ctl.cam) {
      case 'game': {
        // the production chase framing (src/render/camera/CameraRig.tsx), without smoothing
        const sf = smooth01(8, 75, v.speed);
        const air = v.airborne ? 1 : 0;
        set(6.3 + 1.9 * sf + 2 * air + 0.9 * v.boostLevel, 1.8 + 0.5 * sf + 1.1 * air, 0, 2.6 + 0.055 * v.speed, 0.75);
        fov = 60 + 13 * sf + 6 * v.boostLevel + 3 * air;
        break;
      }
      case 'chase':
        set(8.5, 3.0, 0, 3, 0.6);
        break;
      case 'high':
        set(10, 6.5, 2.5, 22, -6);
        break;
      case 'rear':
        set(5.2, 1.2, 0.9, 0, 0.2);
        break;
      case 'side':
        set(1.2, 1.3, 9, 0, 0.3);
        break;
      case 'quarter':
        set(6.5, 2.2, 5.2, 0, 0.2);
        break;
      case 'front':
        set(-8, 1.6, 3.8, 0, 0.2);
        break;
      case 'low':
        set(6.5, 0.55, 1.4, 2, 0.7);
        break;
      case 'top':
        set(7, 15, 0.01, 0, 0);
        break;
      case 'orbit': {
        // keep the user's orbit offset, follow the car
        _v.copy(c).sub(_prevCar);
        camera.position.add(_v);
        if (orbit.current) {
          orbit.current.target.copy(c);
          orbit.current.update();
        }
        break;
      }
    }
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    _prevCar.copy(c);
  }, CAMERA_PRIORITY);
  return ctl.cam === 'orbit' ? <OrbitControls ref={orbit} makeDefault /> : null;
}

/* ------------------------------------------------------------------------------------------ */
/* Scene: sky, ground, lights, environment, placeholder car                                     */
/* ------------------------------------------------------------------------------------------ */

/** Theme sky gradient (zenith -> horizon -> haze band), used for the backdrop and the reflections. */
function createSkyMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uZenith: { value: new Color(THEME.sky.zenith) },
      uHorizon: { value: new Color(THEME.sky.horizon) },
      uHaze: { value: new Color(THEME.sky.haze) },
      uGround: { value: new Color(THEME.concrete).multiplyScalar(0.5) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      uniform vec3 uHaze;
      uniform vec3 uGround;
      varying vec3 vDir;
      void main() {
        float h = normalize(vDir).y;
        vec3 c = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.5));
        c = mix(c, uHaze, exp(-max(h, 0.0) * 14.0));
        c = mix(c, uGround, smoothstep(0.0, -0.08, h));
        gl_FragColor = vec4(c, 1.0);
      }`,
    side: BackSide,
    depthWrite: false,
    fog: false,
  });
}

function Sky() {
  const mat = useMemo(() => createSkyMaterial(), []);
  useEffect(() => () => mat.dispose(), [mat]);
  const ref = useRef<Mesh>(null);
  useFrame(({ camera }) => ref.current?.position.copy(camera.position));
  return (
    <mesh ref={ref} material={mat} renderOrder={-10} frustumCulled={false}>
      <sphereGeometry args={[4000, 32, 16]} />
    </mesh>
  );
}

function makeRunwayTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 512;
  const g = c.getContext('2d')!;
  const base = CONCRETE ? THEME.concrete : THEME.asphalt;
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 512);
  // aggregate speckle
  for (let i = 0; i < 2600; i++) {
    const l = CONCRETE ? 150 + Math.random() * 60 : 30 + Math.random() * 40;
    g.fillStyle = `rgba(${l + 10},${l + 10},${l + 12},${0.18 + Math.random() * 0.25})`;
    g.fillRect(Math.random() * 256, Math.random() * 512, 1.5, 1.5);
  }
  if (CONCRETE) {
    // panel seams
    g.fillStyle = 'rgba(60,58,55,0.35)';
    for (let y = 0; y < 512; y += 128) g.fillRect(0, y, 256, 1.5);
    g.fillRect(127, 0, 1.5, 512);
  } else {
    g.fillStyle = '#e9e6df';
    g.fillRect(10, 0, 5, 512);
    g.fillRect(241, 0, 5, 512);
    g.fillRect(126, 0, 4, 220);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = ClampToEdgeWrapping;
  t.wrapT = RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function Ground() {
  const runway = useMemo(() => makeRunwayTexture(), []);
  useEffect(() => () => runway.dispose(), [runway]);
  const LEN = 14000;
  runway.repeat.set(1, LEN / 36);
  return (
    <group>
      {/* tessellated: huge single-quad planes lose depth precision (z-fighting / decal flicker) */}
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.02, -LEN / 2 + 1500]} receiveShadow>
        <planeGeometry args={[6000, LEN, 60, 280]} />
        <meshStandardMaterial color={THEME.concrete} roughness={0.95} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0, -LEN / 2 + 1500]} receiveShadow>
        <planeGeometry args={[26, LEN, 1, 700]} />
        <meshStandardMaterial map={runway} roughness={0.82} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-2} />
      </mesh>
    </group>
  );
}

/**
 * DevCanvas (shared) requests PCFSoftShadowMap, which three r186 removed (it warns and falls back).
 * Child effects run after DevCanvas's setup effect, so this keeps the sandbox console clean. Also
 * installs the theme fog (FogExp2, like the env module).
 */
function SceneSetup() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    gl.shadowMap.type = PCFShadowMap;
    scene.fog = new FogExp2(THEME.fog.color, THEME.fog.density);
    scene.environmentIntensity = THEME.env.intensity;
    return () => {
      scene.fog = null;
    };
  }, [gl, scene]);
  return null;
}

const _keyDir = dirFromAngles(THEME.key.elevationDeg, THEME.key.azimuthDeg);

function Lights() {
  const sun = useRef<DirectionalLight>(null);
  useFrame(() => {
    const l = sun.current;
    if (!l) return;
    const c = runtime.frame.position;
    l.position.copy(c).addScaledVector(_keyDir, 80);
    l.target.position.copy(c);
    l.target.updateMatrixWorld();
  });
  return (
    <>
      <hemisphereLight args={[THEME.hemi.sky, THEME.hemi.ground, THEME.hemi.intensity]} />
      <directionalLight
        ref={sun}
        intensity={THEME.key.intensity}
        color={THEME.key.color}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-22}
        shadow-camera-right={22}
        shadow-camera-top={22}
        shadow-camera-bottom={-22}
        shadow-camera-near={1}
        shadow-camera-far={200}
        shadow-bias={-0.0004}
      />
    </>
  );
}

/** Reflection environment: theme sky gradient + studio cards (like the env module's EnvironmentMap). */
function Reflections() {
  const sky = useMemo(() => createSkyMaterial(), []);
  useEffect(() => () => sky.dispose(), [sky]);
  return (
    <Environment resolution={256} frames={1}>
      <mesh scale={100} material={sky}>
        <sphereGeometry args={[1, 32, 16]} />
      </mesh>
      {THEME.env.cards.map((c, i) => {
        const p = dirFromAngles(c.elevationDeg, c.azimuthDeg).multiplyScalar(40);
        return (
          <Lightformer
            key={i}
            intensity={c.intensity}
            color={c.color}
            position={[p.x, p.y, p.z]}
            scale={[c.size[0], c.size[1], 1]}
            onUpdate={(o) => o.lookAt(0, 0, 0)}
          />
        );
      })}
    </Environment>
  );
}

function PlaceholderCar() {
  const group = useRef<Group>(null);
  const wheels = useRef<(Group | null)[]>([]);
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const f = runtime.frame;
    g.position.copy(f.position);
    g.quaternion.copy(f.quaternion);
    f.snapshot.vehicle.wheels.forEach((w, i) => {
      const wg = wheels.current[i];
      if (wg) wg.rotation.x = -w.spinAngle;
    });
  });
  const L = VEHICLE.length;
  const W = VEHICLE.width;
  return (
    <group ref={group}>
      <RoundedBox args={[W, 0.6, L]} radius={0.22} smoothness={4} position={[0, VEHICLE.floorY + 0.3, 0]} castShadow receiveShadow>
        <meshPhysicalMaterial color={PALETTE.paint} metalness={0.55} roughness={0.3} clearcoat={1} clearcoatRoughness={0.12} />
      </RoundedBox>
      <RoundedBox args={[W * 0.7, 0.42, L * 0.46]} radius={0.18} smoothness={4} position={[0, 0.56, 0.25]} castShadow>
        <meshPhysicalMaterial color={PALETTE.glass} metalness={0.2} roughness={0.08} clearcoat={1} />
      </RoundedBox>
      {/* light bars */}
      <mesh position={[0, 0.2, -L / 2 + 0.01]}>
        <boxGeometry args={[W * 0.8, 0.035, 0.02]} />
        <meshStandardMaterial color="#000" emissive={PALETTE.warmWhite} emissiveIntensity={3} />
      </mesh>
      <mesh position={[0, 0.22, L / 2 - 0.01]}>
        <boxGeometry args={[W * 0.86, 0.03, 0.02]} />
        <meshStandardMaterial color="#000" emissive={PALETTE.warmWhite} emissiveIntensity={1.2} />
      </mesh>
      {NOZZLES.map((n, i) => (
        <mesh key={i} position={[n.position[0], n.position[1], n.position[2] - 0.08]} rotation-x={Math.PI / 2}>
          <cylinderGeometry args={[n.radius * 1.15, n.radius, 0.2, 24, 1, true]} />
          <meshStandardMaterial color={PALETTE.titanium300} metalness={0.9} roughness={0.3} side={2} />
        </mesh>
      ))}
      {WHEEL_POSITIONS.map(([x, y, z], i) => (
        <group key={i} position={[x, y, z]} ref={(el) => void (wheels.current[i] = el)}>
          <mesh rotation-z={Math.PI / 2} castShadow>
            <cylinderGeometry args={[VEHICLE.wheelRadius, VEHICLE.wheelRadius, 0.3, 28]} />
            <meshStandardMaterial color="#141518" roughness={0.75} />
          </mesh>
          <mesh rotation-z={Math.PI / 2} position={[x < 0 ? -0.152 : 0.152, 0, 0]}>
            <cylinderGeometry args={[0.22, 0.22, 0.01, 6]} />
            <meshStandardMaterial color={PALETTE.titanium200} metalness={0.9} roughness={0.25} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Post: exposure + AgX with the theme look (approximates the post module's FilmGrade)          */
/* ------------------------------------------------------------------------------------------ */

const GRADE_FRAG = /* glsl */ `
uniform float exposure;
uniform vec3 slope;
uniform float power;
uniform float saturation;

vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  const mat3 toRec2020 = mat3(0.6274, 0.0691, 0.0164, 0.3293, 0.9195, 0.0880, 0.0433, 0.0113, 0.8956);
  const mat3 fromRec2020 = mat3(1.6605, -0.1246, -0.0182, -0.5876, 1.1329, -0.1006, -0.0728, -0.0083, 1.1187);
  // column-major, same layout as three's AgXToneMapping (Filament constants)
  const mat3 inset = mat3(0.856627153315983, 0.137318972929847, 0.11189821299995,
                          0.0951212405381588, 0.761241990602591, 0.0767994186031903,
                          0.0482516061458583, 0.101439036467562, 0.811302368396859);
  const mat3 outset = mat3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826,
                           -0.11060664309660323, 1.157823702216272, -0.11060664309660294,
                           -0.016493938717834573, -0.016493938717834257, 1.2519364065950405);
  vec3 c = toRec2020 * (max(inputColor.rgb, 0.0) * exposure);
  c = inset * c;
  c = clamp((log2(max(c, 1e-10)) + 12.47393) / 16.5, 0.0, 1.0);
  c = agxContrast(c);
  // ASC-CDL look in AgX space (Filament)
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = pow(max(c * slope, 0.0), vec3(power));
  c = luma + saturation * (c - luma);
  c = outset * c;
  c = pow(max(c, 0.0), vec3(2.2));
  c = clamp(fromRec2020 * c, 0.0, 1.0);
  outputColor = vec4(c, inputColor.a);
}
`;

class GradeEffect extends Effect {
  constructor(theme: SandboxTheme) {
    super('SandboxGrade', GRADE_FRAG, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, Uniform>([
        ['exposure', new Uniform(theme.exposure)],
        ['slope', new Uniform(new Vector3(...theme.look.slope))],
        ['power', new Uniform(theme.look.power)],
        ['saturation', new Uniform(theme.look.saturation)],
      ]),
    });
  }
}

function Grade() {
  const effect = useMemo(() => new GradeEffect(THEME), []);
  useEffect(() => () => effect.dispose(), [effect]);
  return <primitive object={effect} />;
}

/* ------------------------------------------------------------------------------------------ */
/* Stats probe (DOM text updated at 4 Hz, never React state per frame)                         */
/* ------------------------------------------------------------------------------------------ */

const statsEl = { current: null as HTMLDivElement | null };
const fxStats = { current: null as FXSystem['stats'] | null };

/** Exposes the FX system stats to the overlay (rendered inside <FXProvider>). */
function FXStatsTap() {
  const fx = useFX();
  fxStats.current = fx.stats;
  // debug handle for scripts/shot.mjs --eval (pool inspection, reset / capacity checks)
  (window as unknown as { __fx: FXSystem }).__fx = fx;
  return null;
}

function StatsProbe() {
  const scene = useThree((s) => s.scene);
  // debug handles for scripts/shot.mjs --eval
  (window as unknown as { __fxScene: unknown }).__fxScene = scene;
  (window as unknown as { __fxRuntime: unknown }).__fxRuntime = runtime;
  (window as unknown as { __fxStats: unknown }).__fxStats = fxStats;
  const acc = useRef({ t: 0, frames: 0, fps: 0 });
  useFrame((_, delta) => {
    const a = acc.current;
    a.t += delta;
    a.frames++;
    if (a.t < 0.25) return;
    a.fps = a.frames / a.t;
    a.t = 0;
    a.frames = 0;
    const s = runtime.frame.snapshot;
    const st = fxStats.current;
    if (statsEl.current && st) {
      statsEl.current.textContent =
        `${a.fps.toFixed(0)} fps · ${lastInfo.calls} calls · ${(lastInfo.triangles / 1000).toFixed(0)}k tris\n` +
        `fx cpu ${st.cpuMs.toFixed(2)} ms · smoke ${st.smoke} · glow ${st.glow}\n` +
        `${(s.vehicle.speed * 3.6).toFixed(0)} km/h · t ${s.time.toFixed(2)}`;
    }
  });
  return null;
}

/* ------------------------------------------------------------------------------------------ */
/* UI                                                                                           */
/* ------------------------------------------------------------------------------------------ */

const panel: CSSProperties = {
  position: 'fixed',
  left: 16,
  top: 16,
  width: 300,
  padding: '14px 14px 12px',
  background: 'rgba(18,20,23,0.72)',
  border: '1px solid rgba(163,170,178,0.25)',
  borderRadius: 10,
  backdropFilter: 'blur(10px)',
  font: '12px var(--font-ui)',
  color: 'var(--warm-white)',
  userSelect: 'none',
};
const btn = (active = false): CSSProperties => ({
  padding: '6px 8px',
  borderRadius: 6,
  border: `1px solid ${active ? 'rgba(56,232,255,0.8)' : 'rgba(163,170,178,0.3)'}`,
  background: active ? 'rgba(56,232,255,0.16)' : 'rgba(255,255,255,0.04)',
  color: active ? 'var(--cyan)' : 'var(--warm-white)',
  font: '11px var(--font-ui)',
  cursor: 'pointer',
});

function Overlay() {
  useCtl();
  const trig = (name: string) => () => ctl.pending.push(name);
  const link = (patch: Record<string, string>) => {
    const p = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(patch)) p.set(k, v);
    return `?${p.toString()}`;
  };
  const nextTheme = THEME_KEY === 'morning' ? 'canyon' : THEME_KEY === 'canyon' ? 'night' : 'morning';
  return (
    <div style={panel}>
      <div style={{ font: '13px var(--font-display)', letterSpacing: '0.18em', marginBottom: 2 }}>FX SANDBOX</div>
      <div style={{ color: 'var(--titanium-300)', marginBottom: 10 }}>
        {HOOK_DRIVER ? 'mock (hook)' : MODE} · {THEME_KEY} · quality {QUALITY}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
        <button style={btn()} onClick={trig('perfect')}>1 Perfect</button>
        <button style={btn()} onClick={trig('clean')}>2 Clean</button>
        <button style={btn()} onClick={trig('hard')}>3 Hard</button>
        <button style={btn()} onClick={trig('crash')}>4 Crash</button>
        <button style={btn()} onClick={trig('sparks')}>5 Sparks</button>
        <button style={btn()} onClick={trig('slam')}>6 Slam</button>
        <button style={btn(ctl.boost)} onClick={() => setCtl({ boost: !ctl.boost })}>B Boost</button>
        <button style={btn(ctl.vacuum)} onClick={() => setCtl({ vacuum: !ctl.vacuum })}>V Vacuum</button>
        <button style={btn(ctl.drift)} onClick={() => setCtl({ drift: !ctl.drift })}>D Drift</button>
        <button style={btn(ctl.rcs > 0)} onClick={() => setCtl({ rcs: (ctl.rcs + 1) % 6 })}>T RCS: {RCS_LABELS[ctl.rcs]}</button>
        <button style={btn()} onClick={trig('fuel')}>F Fuel out</button>
        <button style={btn(ctl.paused)} onClick={() => setCtl({ paused: !ctl.paused })}>P Pause</button>
        <button style={btn()} onClick={() => setCtl({ cam: CAMS[(CAMS.indexOf(ctl.cam) + 1) % CAMS.length] })}>C {ctl.cam}</button>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 10, color: 'var(--titanium-300)', flexWrap: 'wrap' }}>
        <a style={{ color: 'inherit' }} href={link({ mode: MODE === 'mock' ? 'manual' : 'mock' })}>
          {MODE === 'mock' ? 'manual mode' : 'mock timeline'}
        </a>
        <a style={{ color: 'inherit' }} href={link({ theme: nextTheme })}>
          {nextTheme}
        </a>
        <a style={{ color: 'inherit' }} href={link({ surface: CONCRETE ? 'asphalt' : 'concrete' })}>
          {CONCRETE ? 'asphalt' : 'concrete'}
        </a>
        <a style={{ color: 'inherit' }} href={link({ mode: 'manual', alt: '9', v: '35', pitch: String(ctl.pitch || 14) })}>
          airborne
        </a>
      </div>
      <div
        ref={(el) => void (statsEl.current = el)}
        style={{ marginTop: 10, whiteSpace: 'pre', font: '11px var(--font-mono)', color: 'var(--titanium-200)' }}
      />
    </div>
  );
}

const KEY_TRIGGERS: Record<string, string> = {
  Digit1: 'perfect',
  Digit2: 'clean',
  Digit3: 'hard',
  Digit4: 'crash',
  Digit5: 'sparks',
  Digit6: 'slam',
  KeyF: 'fuel',
};

function useKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const trigger = KEY_TRIGGERS[e.code];
      if (trigger) {
        ctl.pending.push(trigger);
        e.preventDefault();
        return;
      }
      switch (e.code) {
        case 'KeyB':
          setCtl({ boost: !ctl.boost });
          break;
        case 'KeyV':
          setCtl({ vacuum: !ctl.vacuum });
          break;
        case 'KeyD':
          setCtl({ drift: !ctl.drift });
          break;
        case 'KeyT':
          setCtl({ rcs: (ctl.rcs + 1) % 6 });
          break;
        case 'KeyP':
          setCtl({ paused: !ctl.paused });
          break;
        case 'KeyC':
          setCtl({ cam: CAMS[(CAMS.indexOf(ctl.cam) + 1) % CAMS.length] });
          break;
        case 'ArrowUp':
          setCtl({ pitch: ctl.pitch + 4 });
          break;
        case 'ArrowDown':
          setCtl({ pitch: ctl.pitch - 4 });
          break;
        case 'ArrowLeft':
          setCtl({ roll: ctl.roll - 6 });
          break;
        case 'ArrowRight':
          setCtl({ roll: ctl.roll + 6 });
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function Effects() {
  if (!ONLY) {
    return (
      <GameFX showTrajectory theme={THEME.id}>
        <FXStatsTap />
      </GameFX>
    );
  }
  return (
    <FXProvider theme={THEME.id}>
      <FXStatsTap />
      {ONLY.includes('smoke') && <TireSmoke />}
      {ONLY.includes('landing') && <LandingFX />}
      {ONLY.includes('impact') && <ImpactFX />}
      {ONLY.includes('vacuum') && <VacuumFX />}
      {ONLY.includes('rcs') && <RcsJets />}
      {ONLY.includes('exhaust') && <RocketExhaust />}
      {ONLY.includes('speed') && <SpeedLines />}
      {ONLY.includes('marker') && <LandingMarker />}
      {ONLY.includes('arc') && <TrajectoryArc />}
    </FXProvider>
  );
}

/** Debug: the sprite atlas on a full-screen quad (left: glow + density, right: lit puffs). */
function AtlasView() {
  const fx = useFX();
  const mat = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: { uTex: { value: fx.atlas } },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() { vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform sampler2D uTex;
          varying vec2 vUv;
          void main() {
            vec2 uv = vec2(fract(vUv.x * 2.0), vUv.y);
            vec4 t = texture2D(uTex, uv);
            vec3 c;
            if (vUv.x < 0.5) {
              c = vec3(t.g) + vec3(t.r, 0.0, 0.0) * 0.6;
            } else {
              vec2 n2 = t.ba * 2.0 - 1.0;
              vec3 n = vec3(n2, sqrt(max(0.0, 1.0 - dot(n2, n2))));
              float l = clamp(dot(n, normalize(vec3(0.5, 0.7, 0.5))) * 0.6 + 0.5, 0.0, 1.0);
              c = mix(vec3(0.25, 0.3, 0.38), vec3(1.0), l) * t.g + vec3(0.06, 0.07, 0.09) * (1.0 - t.g);
            }
            gl_FragColor = vec4(c, 1.0);
          }`,
        depthTest: false,
        depthWrite: false,
      }),
    [fx],
  );
  useEffect(() => () => mat.dispose(), [mat]);
  return (
    <mesh material={mat} renderOrder={100} frustumCulled={false}>
      <planeGeometry args={[1, 1]} />
    </mesh>
  );
}

function App() {
  useKeys();
  if (ATLAS) {
    return (
      <DevCanvas orbit={false} readyFrames={10} dpr={1}>
        <FXProvider>
          <AtlasView />
        </FXProvider>
      </DevCanvas>
    );
  }
  return (
    <>
      <DevCanvas orbit={false} readyFrames={1e9} dpr={1.5} camera={{ position: [6, 3, 8], fov: FOV }}>
        <SceneSetup />
        {HOOK_DRIVER ? <HookDriver /> : <SandboxDriver />}
        <CameraRig />
        <Sky />
        <Ground />
        <Lights />
        <Reflections />
        <PlaceholderCar />
        <Effects />
        <StatsProbe />
        <EffectComposer multisampling={4} frameBufferType={HalfFloatType} stencilBuffer={false}>
          <Bloom
            mipmapBlur
            blendFunction={BlendFunction.ADD}
            intensity={THEME.bloom.intensity}
            luminanceThreshold={THEME.bloom.threshold}
            luminanceSmoothing={THEME.bloom.smoothing}
            radius={THEME.bloom.radius}
          />
          <Vignette offset={THEME.vignette.offset} darkness={THEME.vignette.darkness} />
          <Grade />
        </EffectComposer>
      </DevCanvas>
      {SHOW_UI && <Overlay />}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
