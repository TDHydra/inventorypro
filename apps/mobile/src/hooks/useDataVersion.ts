import { useSyncExternalStore } from 'react';
import { subscribeDataVersion, getDataVersion } from '../sync/dataVersion';

// Subscribes a component to the global data-version counter (bumped after a
// sync pull applies changes) so it re-renders — and any memo/effect keyed on
// this value re-runs — without the user having to pull-to-refresh or remount.
export function useDataVersion(): number {
  return useSyncExternalStore(subscribeDataVersion, getDataVersion, getDataVersion);
}
