import { useState } from 'react';

/**
 * A value created once per component instance (lazy, unlike `useRef(init).current`, whose
 * initializer object is rebuilt on every render). Used for the mutable per-effect state that the
 * frame callbacks read and write (never React state).
 */
export function useConst<T>(init: () => T): T {
  return useState(init)[0];
}
