/**
 * Big contextual prompt (tutorial moments), upper centre, above the car.
 * Key names inside the authored text follow the user's bindings / current device.
 */
import { useState } from 'react';
import { useHudStore, type HudPrompt } from '@/state/hudStore';
import { useSettingsStore } from '@/state/settingsStore';
import { HintKeys, adaptHintText } from '../components/Keys';
import { useInputMode, useKeyLabelsVersion, usePresence } from '../hooks';

export function CenterPrompt() {
  const prompt = useHudStore((s) => s.prompt);
  const mode = useInputMode();
  const bindings = useSettingsStore((s) => s.bindings);
  useKeyLabelsVersion();
  // Keep the last prompt around while it animates out. Derived state (set during render, the
  // React-sanctioned way to remember a previous prop) rather than a ref mutated mid-render.
  const [last, setLast] = useState<HudPrompt | null>(prompt);
  if (prompt && prompt !== last) setLast(prompt);
  const { mounted, closing } = usePresence(prompt !== null, 220);
  const p = prompt ?? last;
  if (!mounted || !p) return null;
  return (
    <div className="rf-prompt-wrap">
      <div key={p.id} className="rf-prompt" data-tone={p.tone} data-closing={closing || undefined} role="status" aria-live="assertive">
        {p.hint && <HintKeys hint={p.hint} size="lg" />}
        <span className="rf-prompt__text">{adaptHintText(p.text, p.hint, mode, bindings)}</span>
      </div>
    </div>
  );
}
