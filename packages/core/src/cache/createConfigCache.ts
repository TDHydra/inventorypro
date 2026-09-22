// Generic reactive config cache — the factory that collapses the old app's
// hand-rolled per-domain caches (role-permission overrides, product-class
// units, chat unread, …), which each re-implemented the same shape: a
// module-level snapshot loaded from the local DB, a version counter, a
// listener set, and a reload called at boot + after each sync pull.
//
// Usage:
//   const roleOverrides = createConfigCache({
//     name: 'role-permission-overrides',
//     tables: ['role_settings'],
//     load: () => getRolePermissionOverrides(),
//     fallback: {},
//   });
//   roleOverrides.get() / roleOverrides.useValue() via useSyncExternalStore
//   registerAfterPull(roleOverrides.afterPullHook) at app startup.

import type { AfterPullHook } from '../sync/afterPull';

export interface ConfigCache<T> {
  /** Current snapshot (fallback until the first successful load). */
  get(): T;
  /** Re-read from the DB now. Safe before the DB is initialized — a throwing
   *  load keeps the previous snapshot (the old caches' behavior). Always
   *  bumps + notifies, so subscribers converge even after a swallowed error. */
  reload(): void;
  subscribe(cb: () => void): () => void;
  /** Monotonic version for useSyncExternalStore snapshots. */
  version(): number;
  /** Pre-built hook: register with registerAfterPull() at app startup. Scoped
   *  to `tables` when given, so the cache only re-reads when its tables
   *  changed in a pull. */
  afterPullHook: AfterPullHook;
}

export interface ConfigCacheSpec<T> {
  name: string;
  load(): T;
  fallback: T;
  /** Tables whose pull changes invalidate this cache. Omit to re-read every cycle. */
  tables?: string[];
}

export function createConfigCache<T>(spec: ConfigCacheSpec<T>): ConfigCache<T> {
  let snapshot = spec.fallback;
  let version = 0;
  const listeners = new Set<() => void>();

  function reload(): void {
    try {
      snapshot = spec.load();
    } catch {
      // DB not initialized / column missing — keep whatever we have.
    }
    version++;
    listeners.forEach(l => l());
  }

  return {
    get: () => snapshot,
    reload,
    subscribe(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    version: () => version,
    afterPullHook: { name: `cache:${spec.name}`, tables: spec.tables, run: reload },
  };
}
