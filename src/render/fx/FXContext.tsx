/**
 * React glue for the FX system.
 *
 *   <FXProvider>  creates the shared FXSystem (pools, decals, flash light), mounts it in the scene,
 *                 runs the per-frame pipeline (useFrame priority 0), resets everything on the
 *                 'reset' event / runtime.runId change, and lights smoke from the scene's lights.
 *   useFX()       access the system from an effect component.
 *   useFXFrame()  register a per-frame effect tick; ticks run after pool simulation and before the
 *                 GPU upload, so particles spawned this frame render this frame.
 *   useFXReset()  register transient-state cleanup for restarts.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { createContext, type ReactNode, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Vector3 } from 'three';
import { runtime } from '@/game/runtime';
import type { ThemeId } from '@/game/types';
import { type FXTick, type FXTickRef, FXSystem } from './core/FXSystem';
import { resolveFXTheme } from './core/theme';

const FXContext = createContext<FXSystem | null>(null);

export interface FXProviderProps {
  children?: ReactNode;
  /**
   * World direction towards the key light, used to shade smoke. When omitted, the brightest
   * shadow-casting DirectionalLight of the scene is tracked automatically (the env module's sun);
   * its color / intensity and the hemisphere / ambient fills always drive the smoke brightness.
   */
  lightDirection?: readonly [number, number, number];
  /** Theme used for the FX look (emissive compensation, smoke floors). Default: `runtime.level?.theme`. */
  theme?: ThemeId;
}

const _dir = new Vector3();

export function FXProvider({ children, lightDirection, theme }: FXProviderProps) {
  const [system] = useState(() => new FXSystem(runtime.quality, runtime.frame));
  const scene = useThree((s) => s.scene);

  useEffect(() => {
    const off = runtime.events.on('reset', () => system.reset(runtime.runId));
    return () => {
      off();
      system.dispose();
    };
  }, [system]);

  useEffect(() => {
    if (lightDirection) system.setLightDirection(_dir.set(lightDirection[0], lightDirection[1], lightDirection[2]));
    else system.setLightDirection(null);
  }, [system, lightDirection]);

  useFrame((state) => {
    system.update(
      scene,
      state.camera,
      runtime.frame,
      resolveFXTheme(theme),
      runtime.quality,
      runtime.runId,
      state.clock.elapsedTime,
    );
  });

  return (
    <FXContext.Provider value={system}>
      <primitive object={system.root} />
      {children}
    </FXContext.Provider>
  );
}

/** The FX system of the nearest <FXProvider> (throws outside of one). */
export function useFX(): FXSystem {
  const system = useContext(FXContext);
  if (!system) throw new Error('FX components must be rendered inside <FXProvider> (or <GameFX>).');
  return system;
}

/** Registers `tick` to run every frame inside the FX pipeline (always calls the latest closure). */
export function useFXFrame(tick: FXTick): void {
  const system = useFX();
  const ref = useRef<FXTickRef>({ current: tick });
  useLayoutEffect(() => {
    ref.current.current = tick;
  });
  useLayoutEffect(() => system.addTick(ref.current), [system]);
}

/** Registers transient-state cleanup run on every restart (always calls the latest closure). */
export function useFXReset(cb: () => void): void {
  const system = useFX();
  const ref = useRef(cb);
  useLayoutEffect(() => {
    ref.current = cb;
  });
  useEffect(() => system.onReset(() => ref.current()), [system]);
}
