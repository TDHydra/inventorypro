import { useSyncExternalStore } from 'react';
import {
  getUnitAccessDefaults, subscribeUnitAccessDefaults, getUnitAccessDefaultsVersion,
  type UnitAccessActions,
} from '../db/unitAccessDefaults';

// Ported from apps/mobile/src/hooks/useUnitAccessDefaults.ts (Station C4).
// Mirrors useHiddenFields.ts's shape exactly: useSyncExternalStore subscribes
// to the version counter, and each re-render reads the DB fresh.
/** Reactive per-role unit-access defaults — re-renders on local edits AND sync pulls. */
export function useUnitAccessDefaults(): Record<string, UnitAccessActions> {
  useSyncExternalStore(subscribeUnitAccessDefaults, getUnitAccessDefaultsVersion, getUnitAccessDefaultsVersion);
  return getUnitAccessDefaults();
}
