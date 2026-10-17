/**
 * Persistence helpers shared by the persisted zustand stores (settings, progress).
 *
 * `createSafeStorage()` is a zustand `PersistStorage` that never throws: unavailable
 * localStorage (privacy modes, sandboxed iframes), quota errors and corrupt JSON all degrade
 * to an in-memory copy so the game keeps working for the session.
 */
import type { PersistStorage, StorageValue } from 'zustand/middleware';

function localStorageOrNull(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    // Accessing window.localStorage itself can throw a SecurityError.
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function createSafeStorage<S>(): PersistStorage<S> {
  const memory = new Map<string, string>();
  return {
    getItem(name: string): StorageValue<S> | null {
      let raw: string | null = null;
      try {
        raw = localStorageOrNull()?.getItem(name) ?? null;
      } catch {
        raw = null;
      }
      if (raw === null) raw = memory.get(name) ?? null;
      if (raw === null) return null;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isRecord(parsed) && 'state' in parsed) return parsed as StorageValue<S>;
      } catch {
        /* corrupt entry — fall back to defaults */
      }
      return null;
    },
    setItem(name: string, value: StorageValue<S>): void {
      let raw: string;
      try {
        raw = JSON.stringify(value);
      } catch {
        return;
      }
      memory.set(name, raw);
      try {
        localStorageOrNull()?.setItem(name, raw);
      } catch {
        /* quota exceeded / storage disabled — keep the in-memory copy */
      }
    },
    removeItem(name: string): void {
      memory.delete(name);
      try {
        localStorageOrNull()?.removeItem(name);
      } catch {
        /* ignore */
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Tiny validators used when merging persisted (untrusted) data        */
/* ------------------------------------------------------------------ */

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function asUnit(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}

export function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

export function asFiniteNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function asOneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}
