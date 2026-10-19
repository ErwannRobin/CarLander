/**
 * ROADSTER FLIGHT — shared contracts.
 *
 * This file is the single source of truth for data exchanged between the
 * simulation (src/game), the renderer (src/render), audio (src/audio) and UI (src/ui).
 *
 * Conventions (see ARCHITECTURE.md):
 *  - Units: meters, seconds, kilograms, radians (unless a field name ends in `Deg`).
 *  - World: +Y up. Levels generally progress towards -Z.
 *  - Local frames (car and track frames): right = +X, up = +Y, forward = -Z.
 *  - Wheel order everywhere: 0 = front-left, 1 = front-right, 2 = rear-left, 3 = rear-right.
 *
 * Only additive changes are allowed here once modules depend on it.
 */
import type { Quaternion, Vector3 } from 'three';

export type V3 = [number, number, number];

export type LevelId = 1 | 2 | 3 | 4;
export type ThemeId = 'title' | 'morning' | 'canyon' | 'night';
export type QualityLevel = 'low' | 'medium' | 'high';

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

/** Abstract per-tick control state produced by the input layer (keyboard / touch / gamepad / autopilot). */
export interface InputState {
  /** -1..1. W/Up = +1, S/Down = -1. Ground: accelerate / brake+reverse. Air: pitch (W = nose down, S = nose up). */
  throttle: number;
  /** -1..1. A/Left = -1, D/Right = +1. Ground: steering. Air: yaw. */
  steer: number;
  /** -1..1. Q = -1 (roll left), E = +1 (roll right). Air only (barrel rolls / reorientation). */
  roll: number;
  /** Space (hold): rocket thrusters. */
  boost: boolean;
  /** F (hold): vertical booster — underbody jets along the chassis up axis (hop / landing cushion). Shares the thruster fuel. */
  jump: boolean;
  /** Enter (hold): vacuum adhesion system (only if the level enables it). */
  vacuum: boolean;
  /** Shift (hold): gyro stabilizer — auto-levels the car towards the predicted landing surface. */
  stabilize: boolean;
}

export const NEUTRAL_INPUT: Readonly<InputState> = Object.freeze({
  throttle: 0,
  steer: 0,
  roll: 0,
  boost: false,
  jump: false,
  vacuum: false,
  stabilize: false,
});

/** Rebindable actions. */
export type ControlAction =
  | 'accelerate'
  | 'brake'
  | 'left'
  | 'right'
  | 'rollLeft'
  | 'rollRight'
  | 'boost'
  | 'jump'
  | 'vacuum'
  | 'stabilize'
  | 'restart'
  | 'pause';

/* ------------------------------------------------------------------ */
/* Vehicle                                                             */
/* ------------------------------------------------------------------ */

export type SurfaceKind = 'asphalt' | 'concrete' | 'metal' | 'adhesive' | 'landing' | 'terrain';

export interface WheelState {
  grounded: boolean;
  /** 0 = fully extended (droop), 1 = bump stop. */
  compression: number;
  /** Current distance hardpoint -> wheel center along chassis -up (m). Use for visual wheel placement. */
  suspensionLength: number;
  /** Steering angle (rad). Positive = wheel turned to the car's left. */
  steerAngle: number;
  /** Accumulated wheel spin angle (rad) for visuals. Positive = rolling forward. */
  spinAngle: number;
  /** Wheel angular speed (rad/s), positive = rolling forward. */
  spinRate: number;
  /** 0..1 tire slip intensity (lateral skid or wheelspin) — drives tire smoke and squeal. */
  slip: number;
  /** World contact point (valid when grounded). */
  contactPoint: Vector3;
  /** World contact normal (valid when grounded). */
  contactNormal: Vector3;
  surface: SurfaceKind | null;
}

export type VacuumMode = 'off' | 'armed' | 'engaged';

export interface VacuumState {
  /** Level allows the system. */
  available: boolean;
  /** off = button released; armed = held but no surface in range; engaged = pulling towards a surface. */
  mode: VacuumMode;
  /** 0..1 smoothed suction strength actually applied. */
  strength: number;
  /** Distance from the underbody to the nearest compatible surface (m). Infinity if none. */
  distance: number;
  hasSurface: boolean;
  surfacePoint: Vector3;
  surfaceNormal: Vector3;
}

export interface VehicleState {
  position: Vector3;
  quaternion: Quaternion;
  velocity: Vector3;
  angularVelocity: Vector3;
  /** World-space basis of the chassis. */
  forward: Vector3;
  up: Vector3;
  right: Vector3;
  /** |velocity| in m/s. */
  speed: number;
  /** Signed velocity along chassis forward (m/s). */
  forwardSpeed: number;
  /** FL, FR, RL, RR. */
  wheels: WheelState[];
  groundedWheels: number;
  /** True when no wheel has touched a surface for a short debounce time. */
  airborne: boolean;
  /** Applied throttle (-1..1) after contextual mapping (0 when airborne). */
  throttle: number;
  boosting: boolean;
  /** 0..1 smoothed thrust level for visuals/audio. */
  boostLevel: number;
  /** Vertical booster firing (underbody jets). */
  jumping: boolean;
  /** 0..1 smoothed vertical booster level for visuals. */
  jumpLevel: number;
  /** 0..1 remaining fuel. */
  fuel: number;
  /** Air-control activity per axis, -1..1, in chassis-local axes (pitch about +X, yaw about +Y, roll: + = roll right). Drives RCS jet visuals. */
  rcs: { pitch: number; yaw: number; roll: number };
  stabilizing: boolean;
  vacuum: VacuumState;
  crashed: boolean;
}

/* ------------------------------------------------------------------ */
/* Air, tricks, landing                                                */
/* ------------------------------------------------------------------ */

export type TrickKind = 'frontflip' | 'backflip' | 'spin' | 'barrelRoll' | 'hangTime' | 'inverted' | 'bullseye';

export interface TrickInstance {
  kind: TrickKind;
  /** Display label, e.g. "DOUBLE BACKFLIP", "720 SPIN", "INVERTED 84 m". */
  label: string;
  /** Number of rotations (or 1 for non-rotational tricks). */
  count: number;
  points: number;
}

export type LandingQuality = 'perfect' | 'clean' | 'hard' | 'crash';

export interface LandingResult {
  quality: LandingQuality;
  /** Angle between chassis up and surface normal at touchdown (deg). */
  angleDeg: number;
  /** Impact speed along the surface normal (m/s). */
  impactSpeed: number;
  /** Angle between heading and velocity in the surface plane (deg). */
  driftDeg: number;
  /** Wheels that touched within the touchdown window. */
  wheelsDown: number;
  airTime: number;
  /** Horizontal distance from takeoff to touchdown (m). */
  distance: number;
  /** Max height above takeoff point during the jump (m). */
  maxHeight: number;
  tricks: TrickInstance[];
  basePoints: number;
  multiplier: number;
  points: number;
  /** Landed inside the level target zone (if the level defines one). */
  inTarget: boolean;
  position: Vector3;
}

export interface LandingPrediction {
  valid: boolean;
  point: Vector3;
  normal: Vector3;
  timeToImpact: number;
  /** Angle between the current chassis up and the predicted surface normal (deg). */
  alignmentDeg: number;
  /** Signed attitude error relative to the target surface, in degrees (+pitch = nose too high, +roll = rolled right). */
  pitchErrorDeg: number;
  rollErrorDeg: number;
  /** Quality the landing would get if the attitude/velocity stayed as they are. */
  predictedQuality: LandingQuality;
  inTarget: boolean;
  /** Sampled ballistic path from the car to the impact point (world), <= 48 points. */
  path: Vector3[];
}

export interface AirState {
  airborne: boolean;
  airTime: number;
  /** Height above the surface directly below (m), Infinity if nothing below. */
  height: number;
  /** Horizontal distance since takeoff (m). */
  distance: number;
  maxHeight: number;
  /** Tricks completed during the current jump. */
  tricks: TrickInstance[];
  /** Points at stake if the car lands cleanly. */
  pendingPoints: number;
  /** Accumulated rotation during this jump, in degrees (chassis axes). */
  rotation: { pitch: number; yaw: number; roll: number };
}

export interface ScoreState {
  total: number;
  /** Consecutive non-crash landings chained quickly; feeds the combo multiplier. */
  chain: number;
  comboMultiplier: number;
  lastLanding: LandingResult | null;
  bestLanding: LandingResult | null;
  jumps: number;
  tricks: number;
  maxAirTime: number;
  longestJump: number;
  invertedDistance: number;
  maxSpeed: number;
}

/* ------------------------------------------------------------------ */
/* Objectives / prompts                                                */
/* ------------------------------------------------------------------ */

/** A key-cap style control hint, e.g. { keys: ['SPACE'], label: 'Thrusters' }. Keys are display names of actions. */
export interface ControlHint {
  keys: string[];
  label: string;
  /** Action used to look up the user's current binding for display (preferred over `keys` when present). */
  actions?: ControlAction[];
}

export interface ObjectiveState {
  index: number;
  total: number;
  id: string;
  title: string;
  text: string;
  hints: ControlHint[];
  complete: boolean;
}

/** Large contextual prompt shown center-screen (tutorial moments). */
export interface PromptState {
  id: string;
  text: string;
  hint: ControlHint | null;
  /** Visual urgency for styling. */
  tone: 'info' | 'action' | 'warning' | 'success';
}

/* ------------------------------------------------------------------ */
/* Sim snapshot & events                                               */
/* ------------------------------------------------------------------ */

export type SimPhase = 'ready' | 'running' | 'crashed' | 'complete';

export type CrashReason =
  | 'rollover'
  | 'impact'
  | 'nose-dive'
  | 'roof'
  | 'fell'
  | 'hard-impact'
  | 'missed-platform';

export interface LevelResult {
  levelId: LevelId;
  score: number;
  /** Seconds of sim time from start to completion. */
  time: number;
  medal: 'none' | 'bronze' | 'silver' | 'gold';
  finalLanding: LandingResult;
  bestLanding: LandingResult | null;
  breakdown: { label: string; value: string; points: number }[];
  stats: {
    maxSpeedKmh: number;
    maxAirTime: number;
    longestJump: number;
    tricks: number;
    invertedDistance: number;
  };
}

export interface SimSnapshot {
  tick: number;
  /** Sim seconds since (re)start. */
  time: number;
  phase: SimPhase;
  levelId: LevelId;
  vehicle: VehicleState;
  air: AirState;
  prediction: LandingPrediction | null;
  score: ScoreState;
  objective: ObjectiveState;
  prompt: PromptState | null;
  /** Requested time scale (slow motion moments). 1 = normal. The runner applies it. */
  timeScale: number;
  crashReason: CrashReason | null;
  result: LevelResult | null;
}

export type GameEvent =
  | { type: 'reset' }
  | { type: 'takeoff'; position: Vector3; speed: number }
  | { type: 'landing'; result: LandingResult }
  | { type: 'crash'; reason: CrashReason; position: Vector3; impactSpeed: number }
  | { type: 'trick'; trick: TrickInstance }
  | { type: 'boostStart' }
  | { type: 'boostEnd' }
  | { type: 'jumpStart' }
  | { type: 'jumpEnd' }
  | { type: 'fuelEmpty' }
  | { type: 'vacuumOn' }
  | { type: 'vacuumOff' }
  | { type: 'vacuumEngaged'; position: Vector3; normal: Vector3 }
  | { type: 'vacuumReleased'; position: Vector3 }
  /** Chassis body contact (scrape / hit). strength 0..1. */
  | { type: 'impact'; position: Vector3; normal: Vector3; strength: number }
  /** Hard suspension contact (wheel slam). strength 0..1. */
  | { type: 'wheelSlam'; position: Vector3; strength: number }
  | { type: 'objective'; index: number; id: string; title: string }
  | { type: 'objectiveComplete'; index: number; id: string }
  | { type: 'prompt'; prompt: PromptState | null }
  | { type: 'checkpoint'; id: string }
  | { type: 'zoneEnter'; id: string }
  | { type: 'levelComplete'; result: LevelResult };

export type GameEventType = GameEvent['type'];

/* ------------------------------------------------------------------ */
/* Level definition                                                    */
/* ------------------------------------------------------------------ */

/** Visual style of a track/platform piece (render layer maps it to materials). */
export type TrackStyle =
  | 'runway' // dark asphalt, lane markings
  | 'ramp' // launch ramp: asphalt + orange/white chevrons
  | 'landing' // landing deck: concrete with target rings
  | 'adhesive' // vacuum-compatible deck: polished concrete with cyan micro-pattern (Level 3 crescent)
  | 'platform' // concrete deck
  | 'metal' // brushed titanium deck / structure
  | 'glass'; // dark glass panel (decor)

export type EdgeLight = 'cyan' | 'red' | 'orange' | 'white' | 'none';

/** A sampled frame of a track centerline. Orientation: right=+X, up=+Y, forward=-Z (local). */
export interface TrackFrame {
  /** Arc length from the start of the path (m). */
  s: number;
  position: Vector3;
  quaternion: Quaternion;
  forward: Vector3;
  up: Vector3;
  right: Vector3;
}

export interface RibbonPieceDef {
  kind: 'ribbon';
  id: string;
  /** Centerline frames (build with TrackPath, see src/game/track/TrackPath.ts). */
  frames: TrackFrame[];
  /** Full drive-surface width (m), constant or per arc-length. */
  width: number | ((s: number) => number);
  /** Slab thickness below the drive surface (m). Default 1.2. */
  thickness?: number;
  style: TrackStyle;
  /** Vacuum-compatible surface (default true for ribbons). */
  adhesive?: boolean;
  edgeLights?: EdgeLight;
  /** Generate support pylons under the ribbon (render only). Default true. */
  supports?: boolean;
  /** Height of collidable side rails (m). 0/undefined = none. */
  rails?: number;
  /** Optional per-piece label for debug / signage. */
  label?: string;
}

export interface BoxPieceDef {
  kind: 'box';
  id: string;
  center: V3;
  size: V3;
  /**
   * three.js Euler in degrees `[x, y, z]`, order 'YXZ': y = yaw about +Y (+ = turn left),
   * x = pitch about +X (+ = nose/front edge up for a -Z facing box), z = roll about +Z.
   * Helpers: src/game/track/zones.ts (eulerDeg / quatFromRotationDeg).
   */
  rotationDeg?: V3;
  style: TrackStyle;
  adhesive?: boolean;
  /** Default true. */
  collidable?: boolean;
  edgeLights?: EdgeLight;
}

export type PieceDef = RibbonPieceDef | BoxPieceDef;

export type ZonePurpose = 'target' | 'finish' | 'checkpoint' | 'trigger' | 'gate';

/** Oriented box volume. */
export interface ZoneDef {
  id: string;
  purpose: ZonePurpose;
  center: V3;
  halfSize: V3;
  /** Same convention as BoxPieceDef.rotationDeg. */
  rotationDeg?: V3;
  label?: string;
  /** Render a visible marker for this zone (target rings / gate frame). Default true for target/gate/finish. */
  visible?: boolean;
}

/** Context handed to objective/prompt predicates each tick. */
export interface ObjectiveContext {
  snapshot: SimSnapshot;
  input: InputState;
  /** Events emitted during this tick (before objectives are evaluated). */
  events: readonly GameEvent[];
  inZone(id: string): boolean;
  /** Seconds the current objective has been active. */
  objectiveTime: number;
  /** Arbitrary per-run scratch memory for levels (cleared on reset). */
  memory: Record<string, number | boolean | string>;
  /** True the first attempt of this level in the session (tutorial slow-mo should only play once). */
  firstAttempt: boolean;
}

export interface ObjectiveDef {
  id: string;
  title: string;
  text: string;
  hints: ControlHint[];
  /** Objective completes when this returns true. */
  complete: (ctx: ObjectiveContext) => boolean;
  /** Optional big center prompt while this objective is active and `when` holds. */
  prompt?: {
    text: string;
    hint?: ControlHint;
    tone?: PromptState['tone'];
    when?: (ctx: ObjectiveContext) => boolean;
    /** Time scale to apply while the prompt is shown (tutorial bullet-time). Only on first attempt. */
    slowMo?: number;
  };
}

export interface FloatingHintDef {
  id: string;
  position: V3;
  text: string;
  hint?: ControlHint;
  /** Only shown while this objective index (or id) is active. */
  objectiveId?: string;
}

export interface TouchAssistDef {
  /** The pitch axis (tilt gas / brake) is ignored in the air: a phone still tipped forward would nose-dive. */
  ignorePitch: boolean;
  /** The stabilizer is held automatically from this many seconds after lift-off. */
  autoStabilize: number;
}

export interface LevelDef {
  id: LevelId;
  name: string;
  subtitle: string;
  description: string;
  theme: ThemeId;
  spawn: {
    position: V3;
    /** Heading in degrees; 0 faces -Z, +90 faces -X (turn left). */
    yawDeg: number;
    /** Initial forward speed (m/s). */
    speed?: number;
  };
  /** Falling below this Y is a crash ('fell'). */
  killY: number;
  vacuumEnabled: boolean;
  fuel: {
    /** Seconds of continuous thrust from full. */
    capacity: number;
    /** Seconds of thrust regained per second while grounded. */
    regenPerSec: number;
    /** Delay after landing before regen starts (s). */
    regenDelay: number;
    /** Starting fill 0..1. */
    start: number;
  };
  pieces: PieceDef[];
  zones: ZoneDef[];
  objectives: ObjectiveDef[];
  floatingHints: FloatingHintDef[];
  /** Zone id used for the landing target marker / inTarget evaluation. */
  targetZoneId?: string;
  /**
   * Level completes when a landing (not crash) happens inside `zoneId` after all objectives
   * before the final one are complete, and the car stays stable for `settleTime` seconds.
   */
  finish: { zoneId: string; minQuality: Exclude<LandingQuality, 'crash'>; settleTime: number };
  medals: { bronze: number; silver: number; gold: number };
  /** Touch controls only: beginner help in the air (see sim/touchAssist). */
  touchAssist?: TouchAssistDef;
  /** Optional camera fly-in for the level intro (render). */
  intro?: { from: V3; lookAt: V3; duration: number };
}

/* ------------------------------------------------------------------ */
/* Render frame (runner -> render/audio/ui)                            */
/* ------------------------------------------------------------------ */

export interface RenderFrame {
  /** Interpolated chassis pose for this render frame. */
  position: Vector3;
  quaternion: Quaternion;
  /** Latest simulation snapshot (not interpolated). */
  snapshot: SimSnapshot;
  /** Interpolation factor between previous and current physics tick. */
  alpha: number;
  /** Real (unscaled) frame delta, seconds, clamped. */
  dt: number;
  /** Delta after time scale (slow motion) — use for effects that should slow down with the sim. */
  simDt: number;
  /** Seconds of real time since app start (for ambient animation). */
  time: number;
  paused: boolean;
}

/* ------------------------------------------------------------------ */
/* Settings / progress (UI-owned stores implement these shapes)        */
/* ------------------------------------------------------------------ */

export interface Settings {
  masterVolume: number; // 0..1
  musicVolume: number; // 0..1
  sfxVolume: number; // 0..1
  muted: boolean;
  quality: QualityLevel;
  cameraShake: boolean;
  /** Weak automatic leveling when no rotation input is held in the air. */
  flightAssist: boolean;
  showTrajectory: boolean;
  /** Touch devices: steer by tilting the phone like a steering wheel (falls back to an on-screen stick when off or unavailable). */
  tiltSteering: boolean;
  bindings: Record<ControlAction, string[]>; // KeyboardEvent.code values
}

export interface LevelProgress {
  unlocked: boolean;
  completed: boolean;
  bestScore: number;
  bestMedal: LevelResult['medal'];
  bestLanding: { quality: LandingQuality; angleDeg: number; impactSpeed: number; points: number } | null;
  bestTime: number | null;
  attempts: number;
}
