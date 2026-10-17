/**
 * Boot / loading screen shown while the game initialises (screen === 'boot').
 * Integration calls useAppStore.getState().boot() when ready.
 */
import type { CSSProperties } from 'react';
import './styles/tokens.css';
import './styles/screens.css';

export interface BootScreenProps {
  /** 0..1 loading progress; omit for an indeterminate bar. */
  progress?: number;
  message?: string;
}

export function BootScreen({ progress, message = 'Preparing the facility' }: BootScreenProps) {
  const determinate = typeof progress === 'number' && Number.isFinite(progress);
  return (
    <div className="rf-layer rf-boot" role="status" aria-live="polite">
      <div className="rf-boot__center">
        <div className="rf-boot__mark" aria-label="Roadster Flight">
          Roadster Flight
        </div>
        <div
          className="rf-boot__bar"
          data-indeterminate={!determinate || undefined}
          style={determinate ? ({ '--p': Math.min(1, Math.max(0, progress)) } as CSSProperties) : undefined}
        >
          <span />
        </div>
        <div className="rf-boot__msg">{message}</div>
      </div>
    </div>
  );
}
