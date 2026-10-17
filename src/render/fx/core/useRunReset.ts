import { useFrame } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { runtime } from '@/game/runtime';

/**
 * Restart cleanup for components that also work outside <FXProvider> (SpeedLines, LandingMarker,
 * TrajectoryArc): runs `cb` on the 'reset' game event and whenever `runtime.runId` changes (a level
 * load bumps the run id without necessarily emitting 'reset'). Always calls the latest closure.
 */
export function useRunReset(cb: () => void): void {
  const ref = useRef(cb);
  const runId = useRef(runtime.runId);
  useLayoutEffect(() => {
    ref.current = cb;
  });
  useEffect(
    () =>
      runtime.events.on('reset', () => {
        runId.current = runtime.runId;
        ref.current();
      }),
    [],
  );
  useFrame(() => {
    if (runtime.runId === runId.current) return;
    runId.current = runtime.runId;
    ref.current();
  });
}
