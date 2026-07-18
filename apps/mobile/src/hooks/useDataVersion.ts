import { useSyncExternalStore, useCallback } from 'react';
import {
  subscribeDataVersion, getDataVersion,
  subscribeTables, getTablesVersion,
} from '../sync/dataVersion';

// Subscribes a component to the global data-version counter (bumped after a
// sync pull applies changes) so it re-renders — and any memo/effect keyed on
// this value re-runs — without the user having to pull-to-refresh or remount.
export function useDataVersion(): number {
  return useSyncExternalStore(subscribeDataVersion, getDataVersion, getDataVersion);
}

// Opt-in, selective variant (#64): subscribes only to the given tables so the
// component re-renders when THOSE tables change in a pull, not on every pull.
// A screen that renders only inventory rows won't re-query when a chat message
// arrives. Screens not migrated to this keep using useDataVersion() above.
export function useTableVersion(tables: string[]): number {
  // Stable key so an identical table list reuses the same subscribe/snapshot
  // closures across renders even when the caller passes a fresh array literal.
  const key = tables.join(',');
  const subscribe = useCallback(
    (cb: () => void) => subscribeTables(tables, cb),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  const getSnapshot = useCallback(
    () => getTablesVersion(tables),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
