import RAPIER from '@dimforge/rapier3d-compat';

/**
 * Rapier WASM bootstrap.
 *
 * `initPhysics()` is idempotent: concurrent and repeated calls share one promise, so any module
 * (runner, dev pages, tests) can simply `await initPhysics()` before constructing a GameSim.
 * A failed init clears the cached promise so a later call can retry.
 */
let initPromise: Promise<void> | null = null;
let ready = false;

export function initPhysics(): Promise<void> {
  if (ready) return Promise.resolve();
  if (!initPromise) {
    initPromise = RAPIER.init().then(
      () => {
        ready = true;
      },
      (err: unknown) => {
        initPromise = null;
        throw err;
      },
    );
  }
  return initPromise;
}

/** True once the WASM module is initialized (synchronous check for constructors). */
export function isPhysicsReady(): boolean {
  return ready;
}

/** Throws a descriptive error when physics is used before `await initPhysics()`. */
export function assertPhysicsReady(context: string): void {
  if (!ready) throw new Error(`${context}: Rapier is not initialized — await initPhysics() first.`);
}
