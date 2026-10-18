/**
 * Title-screen tip for phones: how to install the game as an app (PWA).
 * Shown only on touch devices that are not already running installed, and never again once dismissed.
 * Android Chrome gets a real Install button (beforeinstallprompt); iOS Safari gets the manual steps.
 */
import { useEffect, useState } from 'react';
import { Icon } from './components/Icon';

const STORAGE_KEY = 'rf-install-hint-dismissed';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

function isTouchDevice(): boolean {
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

function isInstalled(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches || (navigator as { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function InstallHint() {
  const [visible, setVisible] = useState(() => isTouchDevice() && !isInstalled() && !wasDismissed());
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPrompt(e as InstallPromptEvent);
    };
    const onInstalled = () => setVisible(false);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    setVisible(false);
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      /* private mode: the tip just comes back next visit */
    }
  };
  const install = async () => {
    if (!prompt) return;
    await prompt.prompt();
    setPrompt(null);
    dismiss();
  };

  return (
    <aside className="rf-install" role="note" aria-label="Install the game">
      <div className="rf-install__body">
        <strong className="rf-install__title">Play it like an app</strong>
        {prompt ? (
          <p>Install the game for full screen and a home screen icon.</p>
        ) : isIOS() ? (
          <p>
            Tap <b>Share</b> in Safari, then <b>Add to Home Screen</b>.
          </p>
        ) : (
          <p>
            Open the browser menu <b>⋮</b>, then <b>Install app</b> or <b>Add to Home screen</b>.
          </p>
        )}
        {prompt && (
          <button type="button" className="rf-btn rf-install__cta" onClick={install}>
            Install
          </button>
        )}
      </div>
      <button type="button" className="rf-install__close" aria-label="Dismiss" onClick={dismiss}>
        <Icon name="close" />
      </button>
    </aside>
  );
}
