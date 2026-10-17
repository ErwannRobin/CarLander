import { useEffect, useMemo } from 'react';
import { audio } from '@/audio/AudioEngine';
import { QUALITY_PRESETS } from '@/config/quality';
import { initPhysics } from '@/game/physics/initPhysics';
import { getLevel } from '@/game/levels';
import { runtime } from '@/game/runtime';
import type { LevelId } from '@/game/types';
import { initGyro } from '@/input/gyro';
import { GameCanvas } from '@/render/GameCanvas';
import { GameController } from '@/render/scenes/GameController';
import { GameScene } from '@/render/scenes/GameScene';
import { TitleScene } from '@/render/scenes/TitleScene';
import { useAppStore } from '@/state/appStore';
import { useSettingsStore } from '@/state/settingsStore';
import { Screens } from '@/ui';

/** Boot: physics WASM + fonts, then show the title (or jump into ?level=N for development). */
function useBoot() {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const fonts = Promise.race([
        Promise.all([
          document.fonts.load('400 64px Michroma'),
          document.fonts.load('500 16px "Inter Variable"'),
          document.fonts.load('400 16px "JetBrains Mono"'),
        ]),
        new Promise((r) => setTimeout(r, 2500)),
      ]).catch(() => undefined);
      await Promise.all([initPhysics(), fonts]);
      if (cancelled) return;
      const app = useAppStore.getState();
      app.boot();
      const params = new URLSearchParams(location.search);
      const lvl = Number(params.get('level'));
      if (lvl === 1 || lvl === 2 || lvl === 3) app.startLevel(lvl as LevelId);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
}

/** Audio: unlock on first gesture, follow app scene and mix settings, UI sounds via delegation. */
function useAudioWiring() {
  useEffect(() => {
    const unlock = () => void audio.unlock();
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });

    const applyMix = () => {
      const s = useSettingsStore.getState();
      audio.setMix({ master: s.masterVolume, music: s.musicVolume, sfx: s.sfxVolume, muted: s.muted });
    };
    applyMix();
    const offMix = useSettingsStore.subscribe(applyMix);

    const applyScene = () => {
      const a = useAppStore.getState();
      if (a.screen !== 'playing') audio.setScene('title');
      else if (a.overlay === 'pause' || a.overlay === 'settings') audio.setScene('paused');
      else if (a.overlay === 'complete') audio.setScene('complete');
      else audio.setScene('game');
    };
    applyScene();
    const offScene = useAppStore.subscribe(applyScene);

    // delegated UI sounds for every <button> (and [data-sfx] elements)
    let lastHover: Element | null = null;
    const onOver = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.('button:not(:disabled), [data-sfx]');
      if (el && el !== lastHover) {
        lastHover = el;
        if (e.pointerType === 'mouse') audio.ui('hover');
      } else if (!el) lastHover = null;
    };
    const onClick = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.('button:not(:disabled), [data-sfx]');
      if (!el) return;
      const kind = (el.getAttribute('data-sfx') as 'click' | 'back' | 'start' | 'toggle' | null) ?? 'click';
      audio.ui(kind);
    };
    window.addEventListener('pointerover', onOver);
    window.addEventListener('click', onClick, { capture: true });

    return () => {
      window.removeEventListener('pointerdown', unlock, { capture: true });
      window.removeEventListener('keydown', unlock, { capture: true });
      window.removeEventListener('pointerover', onOver);
      window.removeEventListener('click', onClick, { capture: true });
      offMix();
      offScene();
    };
  }, []);
}

/** Touch devices steer by tilting the phone: ask for the sensor early (iOS wants a tap, on the menus is fine). */
function useTiltSetup() {
  useEffect(() => {
    try {
      if (window.matchMedia('(pointer: coarse)').matches) initGyro();
    } catch {
      /* no matchMedia: not a touch device we can detect */
    }
  }, []);
}

/** Pause automatically when the tab is hidden or the window loses focus during play. */
function useAutoPause() {
  useEffect(() => {
    const pauseIfPlaying = () => {
      const a = useAppStore.getState();
      if (a.screen === 'playing' && a.overlay === 'none') a.pause();
    };
    const onVis = () => {
      if (document.hidden) pauseIfPlaying();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('blur', pauseIfPlaying);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('blur', pauseIfPlaying);
    };
  }, []);
}

export default function App() {
  useBoot();
  useAudioWiring();
  useAutoPause();
  useTiltSetup();

  const screen = useAppStore((s) => s.screen);
  const levelId = useAppStore((s) => s.levelId);
  const qualityLevel = useSettingsStore((s) => s.quality);
  const showTrajectory = useSettingsStore((s) => s.showTrajectory);
  const quality = QUALITY_PRESETS[qualityLevel];
  // Render modules read runtime.quality when they mount; keep it in sync before children render
  // (the scenes are keyed on the quality level so they remount on change).
  runtime.quality = quality;

  const level = useMemo(() => (screen === 'playing' ? getLevel(levelId) : null), [screen, levelId]);

  return (
    <>
      <GameCanvas quality={quality}>
        {level ? (
          <>
            <GameController level={level} />
            <GameScene key={`${level.id}-${qualityLevel}`} level={level} quality={quality} showTrajectory={showTrajectory} />
          </>
        ) : screen !== 'boot' ? (
          <TitleScene key={qualityLevel} quality={quality} variant={screen === 'levelSelect' ? 'menu' : 'title'} />
        ) : null}
      </GameCanvas>
      <Screens />
    </>
  );
}
