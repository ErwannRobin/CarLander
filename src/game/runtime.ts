import { Quaternion, Vector3 } from 'three';
import { EventBus } from './events';
import { createSnapshot } from './snapshot';
import type { LevelDef, RenderFrame } from './types';
import { QUALITY_PRESETS, type QualityPreset } from '@/config/quality';

/**
 * Module-level runtime shared by the renderer, audio and UI.
 *
 * - The GameRunner (or a dev-page mock) writes `runtime.frame` once per rendered frame,
 *   inside a useFrame callback with priority RUNTIME_FRAME_PRIORITY (runs before everything else).
 * - R3F components read `runtime.frame` inside their own useFrame callbacks (never via React state).
 * - Game events are published on `runtime.events`.
 */
export interface GameRuntime {
  frame: RenderFrame;
  events: EventBus;
  level: LevelDef | null;
  quality: QualityPreset;
  /** Incremented each time the run is reset (restart) — components can compare to clear transient state. */
  runId: number;
}

/** useFrame priority used by the runner to publish the frame (lower runs first). */
export const RUNTIME_FRAME_PRIORITY = -100;
/** useFrame priority used by the camera rig (after the runner, before default 0 components). */
export const CAMERA_PRIORITY = -50;

export function createRenderFrame(): RenderFrame {
  return {
    position: new Vector3(),
    quaternion: new Quaternion(),
    snapshot: createSnapshot(),
    alpha: 1,
    dt: 1 / 60,
    simDt: 1 / 60,
    time: 0,
    paused: false,
  };
}

export const runtime: GameRuntime = {
  frame: createRenderFrame(),
  events: new EventBus(),
  level: null,
  quality: QUALITY_PRESETS.high,
  runId: 0,
};
