/**
 * Glue between an InputManager and the app/settings stores:
 *  - bindings follow useSettingsStore;
 *  - input is enabled only while playing with no overlay;
 *  - 'pause' toggles the pause menu, 'restart' restarts the run.
 */
import { useEffect, useState } from 'react';
import { selectInputEnabled, useAppStore } from '@/state/appStore';
import { useSettingsStore } from '@/state/settingsStore';
import { InputManager } from './InputManager';

export function connectInputToStores(manager: InputManager): () => void {
  manager.setBindings(useSettingsStore.getState().bindings);
  const offSettings = useSettingsStore.subscribe((s, prev) => {
    if (s.bindings !== prev.bindings) manager.setBindings(s.bindings);
  });

  manager.setEnabled(selectInputEnabled(useAppStore.getState()));
  const offApp = useAppStore.subscribe((s, prev) => {
    if (s.screen !== prev.screen || s.overlay !== prev.overlay) manager.setEnabled(selectInputEnabled(s));
  });

  const offAction = manager.onAction((a) => {
    const app = useAppStore.getState();
    if (a === 'pause') app.togglePause();
    else app.restart();
  });

  return () => {
    offSettings();
    offApp();
    offAction();
  };
}

/**
 * React convenience: creates an InputManager attached to `window` and connected to the stores
 * for the lifetime of the calling component. Call `manager.sample()` once per sim tick.
 */
export function useInputManager(): InputManager {
  const [manager] = useState(() => new InputManager());
  useEffect(() => {
    manager.attach(window);
    const disconnect = connectInputToStores(manager);
    return () => {
      disconnect();
      manager.detach();
    };
  }, [manager]);
  return manager;
}
