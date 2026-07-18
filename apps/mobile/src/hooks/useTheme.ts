import { useSyncExternalStore } from 'react';
import type { Theme } from '../themes/types';
import { getTheme, getThemeVersion, subscribeTheme } from '../themes/store';

/** Reactive theme access. Re-renders on theme switch (no remount needed). */
export function useTheme(): Theme {
  // Version counter as the store snapshot (3rd arg = web/server snapshot),
  // same shape as usePermission/useHiddenFields.
  useSyncExternalStore(subscribeTheme, getThemeVersion, getThemeVersion);
  return getTheme();
}
