// Module-level "something changed" counter + listeners, mirroring the reactive
// pattern in ../auth/permissions.ts (roleOverridesCache / cacheVersion). Screens
// that read local DB rows subscribe here (via useDataVersion/useSyncExternalStore)
// so an already-open list re-queries after a background sync pull applies new
// rows, instead of staying frozen until the user pulls to refresh or remounts.
let version = 0;
const listeners = new Set<() => void>();

export function bumpDataVersion(): void {
  version++;
  listeners.forEach(l => l());
}

export function subscribeDataVersion(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getDataVersion(): number {
  return version;
}
