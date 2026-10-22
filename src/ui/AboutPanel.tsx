/**
 * About: what the game is, who made it, and a link to the source on GitHub.
 * Opens over the title screen. Esc, B on a gamepad or Done closes it.
 */
import { useRef } from 'react';
import { useAppStore } from '@/state/appStore';
import { Icon } from './components/Icon';
import { useAutoFocus, useKeyDown, useRepeatActivationGuard } from './hooks';
import './styles/tokens.css';
import './styles/components.css';
import './styles/overlays.css';

export const REPO_URL = 'https://github.com/ErwannRobin/CarLander';

export function AboutPanel() {
  const closeAbout = useAppStore((s) => s.closeAbout);

  const doneRef = useRef<HTMLButtonElement>(null);
  useAutoFocus(doneRef);
  useRepeatActivationGuard();
  useKeyDown((e) => {
    if (e.key === 'Escape' && !e.repeat) {
      e.preventDefault();
      closeAbout();
    }
  });

  return (
    <div className="rf-layer rf-overlay rf-settings rf-about" role="dialog" aria-modal="true" aria-labelledby="rf-about-title">
      <div className="rf-settings__scrim" aria-hidden="true" />
      <div className="rf-settings__sheet">
        <header className="rf-settings__head">
          <h1 id="rf-about-title" className="rf-settings__title">
            About
          </h1>
          <button ref={doneRef} type="button" className="rf-btn rf-settings__done" onClick={closeAbout}>
            Done
          </button>
        </header>

        <div className="rf-settings__body rf-about__body">
          <div className="rf-settings__col">
            <section className="rf-settings__section">
              <h2 className="rf-settings__heading">Roadster Flight</h2>
              <p className="rf-about__text">
                A free 3D arcade game for the browser. Launch a rocket-assisted roadster off monumental ramps above the clouds,
                then land it perfectly.
              </p>
            </section>

            <section className="rf-settings__section">
              <h2 className="rf-settings__heading">Source code</h2>
              <p className="rf-about__text">Open source under the MIT license. Read the code, report a bug or send an idea on GitHub.</p>
              <a className="rf-btn rf-about__link" href={REPO_URL} target="_blank" rel="noopener noreferrer" tabIndex={0}>
                <Icon name="external" className="rf-btn__icon" />
                View on GitHub
              </a>
            </section>

            <section className="rf-settings__section">
              <h2 className="rf-settings__heading">Credits</h2>
              <p className="rf-about__text">
                Prompted with love by{' '}
                <a className="rf-about__inline" href="https://erwann.app" target="_blank" rel="noopener noreferrer" tabIndex={0}>
                  Erwann
                </a>
                .
              </p>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
