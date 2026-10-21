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
import { applyTouchAssist } from '@/game/sim/touchAssist';
import type { LevelDef } from '@/game/types';
import { calibrateTilt } from '@/input/gyro';
import { InputManager } from '@/input/InputManager';
import { touchInput } from '@/input/touchInput';
import { cameraServices } from '@/render/camera/cameraServices';
import { useAppStore } from '@/state/appStore';
import { useCountdownStore } from '@/state/countdownStore';
import { publishHud } from '@/state/hudStore';
import { ClipRecorder, pickRecordingFormat } from '@/render/replay/ClipRecorder';
import { useProgressStore } from '@/state/progressStore';
import { replayControl, useReplayStore } from '@/state/replayStore';
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

/** `?nocountdown=1`: no 3-2-1 before departure (QA and screenshot scripts). */
const NO_COUNTDOWN = typeof location !== 'undefined' && new URLSearchParams(location.search).has('nocountdown');

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
        const sampled = input.sample();
        const assist = runner.level?.touchAssist;
        return assist && touchInput.active && runner.sim ? applyTouchAssist(sampled, runner.sim.snapshot, assist) : sampled;
      },
      onEvent: (e) => {
        audio.handleEvent(e);
        if (e.type === 'levelComplete') {
          useProgressStore.getState().recordResult(e.result);
          useAppStore.getState().showComplete(e.result);
        }
      },
      // the replay plays the run's sounds again, but not its fanfare
      onReplayEvent: (e) => {
        if (e.type !== 'levelComplete') audio.handleEvent(e);
      },
      onReplay: (status) => {
        const rs = useReplayStore.getState();
        // spectator view only once the clip is on screen (while seeking the results orbit stays)
        runtime.replay.spectator = rs.camera === 'spectator' && status.phase !== 'seeking';
        rs.set({ phase: status.phase, seek: status.seek, progress: status.progress, scale: status.scale });
      },
      requestRestart: () => useAppStore.getState().restart(),
      publishHud: () => {
        if (runner.sim) publishHud(runner.sim.snapshot);
      },
      onCountdown: (step) => {
        useCountdownStore.getState().set(step);
        if (step === null) return;
        audio.ui(step === 0 ? 'start' : 'click');
        // the pose the phone is held in as the lights go green is "no gas, no brake"
        if (step === 0) calibrateTilt();
      },
    });
    runner.countdownEnabled = !NO_COUNTDOWN;
    runner.setFlightAssist(useSettingsStore.getState().flightAssist);
    runnerRef.current = runner;

    cameraServices.raycast = (origin, dir, maxDist) => {
      const sim = runner.activeSim;
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

  // ---- replay: start / stop / options / video export ----
  const recorderRef = useRef<{ rec: ClipRecorder } | null>(null);
  const armRecording = useRef<{ mime: string; ext: string } | null>(null);
  const replayApi = useRef({
    enter: () => {},
    leave: () => {},
  });

  useEffect(() => {
    const store = useReplayStore;
    const runner = () => runnerRef.current;
    store.getState().set({ exportSupported: pickRecordingFormat() !== null });

    const options = () => {
      const rs = store.getState();
      return { autoSlowmo: rs.autoSlowmo, speed: rs.speed, paused: rs.paused };
    };
    const start = () => {
      const r = runner();
      if (!r) return;
      store.getState().set({ phase: 'seeking', seek: 0, progress: 0 });
      r.startReplay(options());
    };
    const cancelRecording = () => {
      recorderRef.current?.rec.cancel();
      recorderRef.current = null;
    };
    replayApi.current = {
      enter: () => {
        store.getState().reset();
        store.getState().set({ exportSupported: pickRecordingFormat() !== null });
        runtime.replay.spectator = false;
        start();
      },
      leave: () => {
        cancelRecording();
        runner()?.stopReplay();
        runtime.replay.spectator = true;
        store.getState().reset();
        store.getState().set({ exportSupported: pickRecordingFormat() !== null });
      },
    };
    replayControl.restart = () => {
      cancelRecording();
      store.getState().set({ paused: false, exportPhase: 'idle' });
      start();
    };
    replayControl.exportClip = () => {
      const format = pickRecordingFormat();
      if (!format) return;
      cancelRecording();
      const rs = store.getState();
      if (rs.exportUrl) URL.revokeObjectURL(rs.exportUrl);
      store.getState().set({ paused: false, exportPhase: 'recording', exportUrl: null, exportError: null });
      // record from the top of the clip: wait for the re-simulation, then capture until it ends
      armRecording.current = format;
      start();
    };

    const offStore = store.subscribe((s, prev) => {
      if (s.paused !== prev.paused || s.speed !== prev.speed || s.autoSlowmo !== prev.autoSlowmo) runner()?.setReplayOptions(options());
      if (s.camera !== prev.camera && runtime.replay.active) runtime.replay.spectator = s.camera === 'spectator' && s.phase !== 'seeking';
      const rec = recorderRef.current;
      if (s.phase !== prev.phase) {
        if (s.phase === 'playing' && armRecording.current && !rec) {
          try {
            const rec = new ClipRecorder(gl.domElement, armRecording.current);
            recorderRef.current = { rec };
          } catch (err) {
            store.getState().set({ exportPhase: 'error', exportError: err instanceof Error ? err.message : 'Recording failed.' });
          }
          armRecording.current = null;
        } else if (s.phase === 'ended' && rec) {
          recorderRef.current = null;
          const name = `roadster-flight-level-${useAppStore.getState().levelId}-replay`;
          window.setTimeout(() => {
            rec.rec.stop().then(
              (blob) => {
                const url = URL.createObjectURL(blob);
                store.getState().set({ exportPhase: 'done', exportUrl: url, exportName: `${name}.${rec.rec.ext}` });
                const a = document.createElement('a');
                a.href = url;
                a.download = `${name}.${rec.rec.ext}`;
                document.body.appendChild(a);
                a.click();
                a.remove();
              },
              (err: unknown) => store.getState().set({ exportPhase: 'error', exportError: err instanceof Error ? err.message : 'Recording failed.' }),
            );
          }, 600);
        }
      }
    });
    return () => {
      offStore();
      cancelRecording();
      armRecording.current = null;
      replayControl.restart = () => {};
      replayControl.exportClip = () => {};
    };
  }, [gl]);
  const enterReplay = () => replayApi.current.enter();
  const leaveReplay = () => replayApi.current.leave();

  // ---- restart / pause / settings wiring ----
  useEffect(() => {
    const apply = () => {
      const app = useAppStore.getState();
      const runner = runnerRef.current;
      const input = inputRef.current;
      if (!runner || !input) return;
      const paused = app.overlay === 'pause' || app.overlay === 'settings';
      runner.paused = paused;
      input.setEnabled(!paused && app.overlay !== 'complete' && app.overlay !== 'replay');
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
      if (s.screen !== 'playing' || s.runNonce !== prev.runNonce) leaveReplay();
      else if (s.overlay === 'replay' && prev.overlay !== 'replay') enterReplay();
      else if (s.overlay !== 'replay' && prev.overlay === 'replay') leaveReplay();
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
