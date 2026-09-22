import { useCallback, useMemo, useSyncExternalStore, type DependencyList } from 'react';
import {
  subscribeDataVersion, getDataVersion,
  subscribeTables, getTablesVersion,
} from '../sync/dataVersion';

// Resolves the (subscribe, getSnapshot) pair `useDbQuery` hands to
// useSyncExternalStore for a given `tables` argument — table-scoped
// (subscribeTables/getTablesVersion, ../sync/dataVersion.ts) when `tables` is
// given, global (subscribeDataVersion/getDataVersion, same store useDataVersion()
// reads) otherwise. This is the only novel logic in this hook (the uSES/useMemo
// composition below is React's own machinery), so it's pulled out and exported
// to be unit-testable without mounting a component — mirrors `sameRows` in
// ./useReactiveRows.ts.
export function subscribeFor(tables: string[] | undefined, cb: () => void): () => void {
  return tables ? subscribeTables(tables, cb) : subscribeDataVersion(cb);
}
export function snapshotFor(tables: string[] | undefined): number {
  return tables ? getTablesVersion(tables) : getDataVersion();
}

/**
 * Memoizes a synchronous local-DB read (`fn`) and re-runs it whenever the data
 * it depends on changes — either any of `deps` change (plain useMemo semantics),
 * or the local DB does, per the `tables` argument:
 *
 * - `tables` given: subscribes to just those tables (../sync/dataVersion.ts
 *   per-table counters, #64) — a pull or local write that never touches them
 *   is a no-op re-render for this call site.
 * - `tables` omitted: falls back to the global data-version counter (the same
 *   one ../hooks/useDataVersion.ts's `useDataVersion()` reads) — re-runs on
 *   ANY change, same as every un-migrated screen today.
 *
 * Builds on the existing dataVersion store — no parallel store, no
 * loading/error state (every `src/db/queries/*` read is `executeSync`,
 * synchronous, so there is nothing to await).
 *
 * `fn` may be an inline closure — its identity is irrelevant, only `deps` (and
 * the resolved table/global version) form the memo key, exactly like `useMemo`.
 * `tables`, if passed, must be call-site-constant: its CONTENT (not array
 * identity) must be the same on every render of a given call site — the same
 * contract `useTableVersion` (./useDataVersion.ts:18-34) already relies on.
 */
export function useDbQuery<T>(
  fn: () => T,
  deps: DependencyList,
  tables?: string[],
): T {
  // Stable key so an identical (or absent) table list reuses the same
  // subscribe/getSnapshot closures across renders — mirrors useTableVersion
  // (./useDataVersion.ts:18-34) and avoids the conditional-hook trap of
  // branching which uSES args to pass based on a value that can change shape.
  const key = tables?.join(',') ?? '';
  const subscribe = useCallback(
    (cb: () => void) => subscribeFor(tables, cb),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  const getSnapshot = useCallback(
    () => snapshotFor(tables),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  const version = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` is the extra invalidation key; fn's own deps are `deps`
  return useMemo(fn, [version, ...deps]);
}
