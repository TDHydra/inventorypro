import { useSyncExternalStore } from 'react';
import {
  getUnitAccessDefaults, subscribeUnitAccessDefaults, getUnitAccessDefaultsVersion,
  type UnitAccessActions,
} from '../db/unitAccessDefaults';

/** Reactive per-role unit-access defaults — re-renders on local edits AND sync pulls. */
export function useUnitAccessDefaults(): Record<string, UnitAccessActions> {
  useSyncExternalStore(subscribeUnitAccessDefaults, getUnitAccessDefaultsVersion, getUnitAccessDefaultsVersion);
  return getUnitAccessDefaults();
}
