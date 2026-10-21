/**
 * Replay screen state (shown over the finished level): playback phase and options, plus the state
 * of the video export. The GameController pushes runner status in and reads the options out;
 * `replayControl` carries the commands the UI sends back.
 */
import { create } from 'zustand';

export type ReplaySpeed = 1 | 0.5 | 0.25;
export type ReplayCamera = 'spectator' | 'chase';
export type ExportPhase = 'idle' | 'recording' | 'done' | 'error';

export interface ReplayState {
  phase: 'idle' | 'seeking' | 'playing' | 'ended';
  /** 0..1 re-simulating up to the start of the clip. */
  seek: number;
  /** 0..1 through the clip. */
  progress: number;
  /** Time scale on screen now (1 = real time). */
  scale: number;
  paused: boolean;
  speed: ReplaySpeed;
  autoSlowmo: boolean;
  camera: ReplayCamera;
  exportSupported: boolean;
  exportPhase: ExportPhase;
  exportUrl: string | null;
  exportName: string;
  exportError: string | null;
  set(patch: Partial<Omit<ReplayState, 'set'>>): void;
  /** Back to the defaults for a fresh replay session (keeps `exportSupported`). */
  reset(): void;
}

const initial = {
  phase: 'idle' as const,
  seek: 0,
  progress: 0,
  scale: 1,
  paused: false,
  speed: 1 as ReplaySpeed,
  autoSlowmo: true,
  camera: 'spectator' as ReplayCamera,
  exportPhase: 'idle' as ExportPhase,
  exportUrl: null,
  exportName: 'roadster-flight-replay.mp4',
  exportError: null,
};

export const useReplayStore = create<ReplayState>()((set, get) => ({
  ...initial,
  exportSupported: false,
  set: (patch) => set(patch),
  reset: () => {
    const url = get().exportUrl;
    if (url) URL.revokeObjectURL(url);
    set({ ...initial });
  },
}));

/** Commands from the replay UI to the game controller (set while a level is mounted). */
export const replayControl: {
  /** Play the clip again from its start. */
  restart: () => void;
  /** Record the clip as shown (camera, slow motion) and offer the file. */
  exportClip: () => void;
} = {
  restart: () => {},
  exportClip: () => {},
};
