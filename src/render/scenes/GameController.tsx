/**
 * Bridges the GameRunner (sim stepping) with the app stores, input, audio, HUD and camera services.
 * Mounted inside the Canvas while a level is being played; survives graphics-quality remounts.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { Vector3 } from 'three';
import { audio } from '@/audio/AudioEngine';
import { devHooks } from '@/game/devHooks';
import { GameRunner } from '@/game/GameRunner';
import { createLevelPilot } from '@/game/levels';
import { runtime, RUNTIME_FRAME_PRIORITY } from '@/game/runtime';
import type { LevelDef } from '@/game/types';
import { InputManager } from '@/input/InputManager';
import { cameraServices } from '@/render/camera/cameraServices';
import { useAppStore } from '@/state/appStore';
import { publishHud } from '@/state/hudStore';
import { useProgressStore } from '@/state/progressStore';
import { useSettingsStore } from '@/state/settingsStore';

const rayDir = new Vector3();

/** `?autopilot=1`: the level's reference autopilot drives every run (demo / QA playthroughs). */
const DEMO_AUTOPILOT = typeof location !== 'undefined' && new URLSearchParams(location.search).get('autopilot') === '1';
let demoPilotOn = DEMO_AUTOPILOT;

/** Give the next run a fresh reference pilot when demo mode is on. */
function armDemoPilot(level: LevelDef | null) {
  if (!level) return;
  if (demoPilotOn) devHooks.autopilot = createLevelPilot(level.id).asFunction();
}

/** Per-frame renderer totals (all passes: shadows, scene, post) for QA via `window.__game.frameStats()`. */
export interface FrameStats {
  calls: number;
  triangles: number;
  points: number;
  lines: number;
  geometries: number;
  textures: number;
  programs: number;
}

export function GameController({ level }: { level: LevelDef }) {
  const runnerRef = useRef<GameRunner | null>(null);
  const inputRef = useRef<InputManager | null>(null);
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  const statsRef = useRef<{ armed: boolean; resolve: ((s: FrameStats) => void) | null }>({ armed: false, resolve: null });

  // ---- create runner + input once ----
  useEffect(() => {
    const input = new InputManager();
    input.attach(window);
    input.setBindings(useSettingsStore.getState().bindings);
    inputRef.current = input;

    const runner = new GameRunner({
      sampleInput: () => {
        const ap = devHooks.autopilot;
        if (ap && runner.sim) return ap(runner.sim.snapshot);
        return input.sample();
      },
      onEvent: (e) => {
        audio.handleEvent(e);
        if (e.type === 'levelComplete') {
          useProgressStore.getState().recordResult(e.result);
          useAppStore.getState().showComplete(e.result);
        }
      },
      requestRestart: () => useAppStore.getState().restart(),
      publishHud: () => {
        if (runner.sim) publishHud(runner.sim.snapshot);
      },
    });
    runner.setFlightAssist(useSettingsStore.getState().flightAssist);
    runnerRef.current = runner;

    cameraServices.raycast = (origin, dir, maxDist) => {
      const sim = runner.sim;
      if (!sim) return null;
      rayDir.copy(dir).normalize();
      const hit = sim.physics.raycast(origin, rayDir, maxDist);
      return hit ? hit.distance : null;
    };

    (window as unknown as { __game?: unknown }).__game = {
      runner,
      runtime,
      devHooks,
      camera,
      scene,
      stores: { app: useAppStore, settings: useSettingsStore, progress: useProgressStore },
      /** Renderer totals of one complete frame (all passes). */
      frameStats(): Promise<FrameStats> {
        return new Promise((resolve) => {
          statsRef.current.resolve = resolve;
          statsRef.current.armed = false;
        });
      },
      /** Toggle the level's reference autopilot (fresh pilot from the current run state). */
      autopilot(on: boolean) {
        demoPilotOn = on;
        devHooks.autopilot = null;
        if (on) armDemoPilot(runner.level);
      },
      get sim() {
        return runner.sim;
      },
      get snapshot() {
        return runner.sim?.snapshot ?? null;
      },
    };

    const offAction = input.onAction((a) => {
      const app = useAppStore.getState();
      if (app.screen !== 'playing') return;
      if (a === 'restart') {
        if (app.overlay === 'none' || app.overlay === 'complete') app.restart();
      } else if (a === 'pause') {
        if (app.overlay === 'none' || app.overlay === 'pause') app.togglePause();
        else if (app.overlay === 'settings') app.closeSettings();
      }
    });

    return () => {
      offAction();
      input.detach();
      runner.dispose();
      devHooks.autopilot = null;
      runnerRef.current = null;
      inputRef.current = null;
      cameraServices.raycast = null;
    };
  }, []);

  // ---- load level ----
  useEffect(() => {
    const runner = runnerRef.current;
    if (!runner) return;
    runner.load(level);
    armDemoPilot(level);
    cameraServices.introPending = true;
    useProgressStore.getState().recordAttempt(level.id);
  }, [level]);

  // ---- restart / pause / settings wiring ----
  useEffect(() => {
    const apply = () => {
      const app = useAppStore.getState();
      const runner = runnerRef.current;
      const input = inputRef.current;
      if (!runner || !input) return;
      const paused = app.overlay === 'pause' || app.overlay === 'settings';
      runner.paused = paused;
      input.setEnabled(!paused && app.overlay !== 'complete');
      if (paused) input.clear();
    };
    apply();
    const offApp = useAppStore.subscribe((s, prev) => {
      if (s.runNonce !== prev.runNonce && s.screen === 'playing' && s.levelId === level.id) {
        runnerRef.current?.restart();
        armDemoPilot(level);
        useProgressStore.getState().recordAttempt(level.id);
      }
      if (s.overlay !== prev.overlay) apply();
    });
    const applySettings = () => {
      const st = useSettingsStore.getState();
      inputRef.current?.setBindings(st.bindings);
      runnerRef.current?.setFlightAssist(st.flightAssist);
      cameraServices.shake = st.cameraShake;
    };
    applySettings();
    const offSettings = useSettingsStore.subscribe(applySettings);
    return () => {
      offApp();
      offSettings();
    };
  }, [level]);

  // Frame-stats probe: runs first every frame. Arms counting for one whole frame, reads it the next.
  useFrame(() => {
    const st = statsRef.current;
    if (!st.resolve) return;
    if (!st.armed) {
      gl.info.autoReset = false;
      gl.info.reset();
      st.armed = true;
      return;
    }
    const i = gl.info;
    const out: FrameStats = {
      calls: i.render.calls,
      triangles: i.render.triangles,
      points: i.render.points,
      lines: i.render.lines,
      geometries: i.memory.geometries,
      textures: i.memory.textures,
      programs: i.programs?.length ?? 0,
    };
    i.autoReset = true;
    st.armed = false;
    const resolve = st.resolve;
    st.resolve = null;
    resolve(out);
  }, -1000);

  useFrame((state, delta) => {
    const runner = runnerRef.current;
    if (!runner) return;
    runner.update(delta, state.clock.elapsedTime);
    audio.update(runtime.frame);
  }, RUNTIME_FRAME_PRIORITY);

  return null;
}
