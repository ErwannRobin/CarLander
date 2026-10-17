import { Quaternion, Vector3 } from 'three';
import type {
  AirState,
  LevelId,
  ObjectiveState,
  ScoreState,
  SimSnapshot,
  VacuumState,
  VehicleState,
  WheelState,
} from './types';

export function createWheelState(): WheelState {
  return {
    grounded: false,
    compression: 0,
    suspensionLength: 0.3,
    steerAngle: 0,
    spinAngle: 0,
    spinRate: 0,
    slip: 0,
    contactPoint: new Vector3(),
    contactNormal: new Vector3(0, 1, 0),
    surface: null,
  };
}

export function createVacuumState(available = false): VacuumState {
  return {
    available,
    mode: 'off',
    strength: 0,
    distance: Infinity,
    hasSurface: false,
    surfacePoint: new Vector3(),
    surfaceNormal: new Vector3(0, 1, 0),
  };
}

export function createVehicleState(): VehicleState {
  return {
    position: new Vector3(),
    quaternion: new Quaternion(),
    velocity: new Vector3(),
    angularVelocity: new Vector3(),
    forward: new Vector3(0, 0, -1),
    up: new Vector3(0, 1, 0),
    right: new Vector3(1, 0, 0),
    speed: 0,
    forwardSpeed: 0,
    wheels: [createWheelState(), createWheelState(), createWheelState(), createWheelState()],
    groundedWheels: 0,
    airborne: false,
    throttle: 0,
    boosting: false,
    boostLevel: 0,
    jumping: false,
    jumpLevel: 0,
    fuel: 1,
    rcs: { pitch: 0, yaw: 0, roll: 0 },
    stabilizing: false,
    vacuum: createVacuumState(),
    crashed: false,
  };
}

export function createAirState(): AirState {
  return {
    airborne: false,
    airTime: 0,
    height: 0,
    distance: 0,
    maxHeight: 0,
    tricks: [],
    pendingPoints: 0,
    rotation: { pitch: 0, yaw: 0, roll: 0 },
  };
}

export function createScoreState(): ScoreState {
  return {
    total: 0,
    chain: 0,
    comboMultiplier: 1,
    lastLanding: null,
    bestLanding: null,
    jumps: 0,
    tricks: 0,
    maxAirTime: 0,
    longestJump: 0,
    invertedDistance: 0,
    maxSpeed: 0,
  };
}

export function createObjectiveState(): ObjectiveState {
  return { index: 0, total: 0, id: '', title: '', text: '', hints: [], complete: false };
}

export function createSnapshot(levelId: LevelId = 1): SimSnapshot {
  return {
    tick: 0,
    time: 0,
    phase: 'ready',
    levelId,
    vehicle: createVehicleState(),
    air: createAirState(),
    prediction: null,
    score: createScoreState(),
    objective: createObjectiveState(),
    prompt: null,
    timeScale: 1,
    crashReason: null,
    result: null,
  };
}
