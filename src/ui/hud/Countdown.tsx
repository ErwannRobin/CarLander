/**
 * 3 - 2 - 1 - GO over the middle of the screen before every departure. The car waits at the line
 * while it counts (GameRunner); GO stays up for a moment once it is driving.
 */
import { useEffect, useState } from 'react';
import { useCountdownStore } from '@/state/countdownStore';

const GO_MS = 800;

export function Countdown() {
  const step = useCountdownStore((s) => s.step);
  const [goDone, setGoDone] = useState(false);

  useEffect(() => {
    if (step !== 0) {
      setGoDone(false);
      return;
    }
    const t = window.setTimeout(() => setGoDone(true), GO_MS);
    return () => window.clearTimeout(t);
  }, [step]);

  if (step === null || (step === 0 && goDone)) return null;
  const go = step === 0;
  return (
    <div className="rf-countdown" role="status" aria-live="assertive">
      <span key={step} className="rf-countdown__num" data-go={go || undefined}>
        {go ? 'GO' : step}
      </span>
    </div>
  );
}
