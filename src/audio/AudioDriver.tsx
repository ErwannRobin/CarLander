/**
 * Drop-in R3F bridge: place inside the game <Canvas>. Each rendered frame it feeds `runtime.frame` to
 * the audio engine (default priority 0 — after the runner published the frame at -100), and forwards
 * every runtime event to `audio.handleEvent`. Renders nothing.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect } from 'react';
import { runtime } from '@/game/runtime';
import { audio } from './AudioEngine';

export function AudioDriver(): null {
  useEffect(() => {
    const off = runtime.events.onAny(audio.handleEvent);
    return () => {
      off();
    };
  }, []);
  useFrame(() => audio.update(runtime.frame));
  return null;
}
