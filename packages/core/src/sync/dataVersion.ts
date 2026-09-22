// Module-level "something changed" counter + listeners, mirroring the reactive
// pattern in ../auth/permissions.ts (roleOverridesCache / cacheVersion). Screens
// that read local DB rows subscribe here (via useDataVersion/useSyncExternalStore)
// so an already-open list re-queries after a background sync pull applies new
// rows, instead of staying frozen until the user pulls to refresh or remounts.
let version = 0;
const listeners = new Set<() => void>();

// Per-table version counters + their listeners (#64). A screen can subscribe to
// only the tables it renders (via subscribeTables / useTableVersion) and skip
// re-querying when an unrelated table — e.g. a new chat message — lands in a
// sync pull. The global counter above still bumps on ANY change, so screens
// still on useDataVersion() keep updating exactly as before.
const tableVersions: Record<string, number> = {};
const tableListeners = new Map<string, Set<() => void>>();

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

// Pure core (no op-sqlite dependency, so it's unit-testable under node --test):
// bump the given changed tables' counters, bump the global counter too, and
// notify every affected listener exactly once. Called by the sync pull with the
// SET of tables it actually applied rows to. An empty set is a no-op.
export function bumpTablesVersion(tables: Iterable<string>): void {
  const toNotify = new Set<() => void>();
  let any = false;
  for (const table of tables) {
    any = true;
    tableVersions[table] = (tableVersions[table] ?? 0) + 1;
    const ls = tableListeners.get(table);
    if (ls) ls.forEach(l => toNotify.add(l));
  }
  if (!any) return;
  // Bump the global counter too so un-migrated useDataVersion() screens still
  // refresh on any change (backward compatible). Deduped via the Set below in
  // case a listener is subscribed both globally and per-table.
  version++;
  listeners.forEach(l => toNotify.add(l));
  toNotify.forEach(l => l());
}

export function subscribeTables(tables: string[], cb: () => void): () => void {
  for (const table of tables) {
    let ls = tableListeners.get(table);
    if (!ls) { ls = new Set(); tableListeners.set(table, ls); }
    ls.add(cb);
  }
  return () => {
    for (const table of tables) {
      const ls = tableListeners.get(table);
      if (!ls) continue;
      ls.delete(cb);
      if (ls.size === 0) tableListeners.delete(table);
    }
  };
}

// Combined snapshot for a table set — monotonically increases whenever any of
// the given tables bumps, so useSyncExternalStore re-renders. Returns a plain
// number (compared by value), so recomputing it every call is safe.
export function getTablesVersion(tables: string[]): number {
  let sum = 0;
  for (const table of tables) sum += tableVersions[table] ?? 0;
  return sum;
}
