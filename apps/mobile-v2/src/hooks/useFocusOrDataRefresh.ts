// Ported from apps/mobile/src/hooks/useFocusOrDataRefresh.ts. Import mapping:
// './useDataVersion' (old, local) → '@invenpro/core' (useDataVersion lives there in v2).
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { useDataVersion } from '@invenpro/core';

/**
 * THE refresh key for screens that read the local DB. Returns a counter that
 * changes when the screen regains focus OR when a background sync pull applies
 * changes (dataVersion bump) — so `useMemo`/`useEffect` keyed on it re-read the
 * DB both on refocus and live while the screen is open.
 *
 * Both inputs only ever increment, so their sum changes on either event.
 *
 * Usage:
 *   const refreshKey = useFocusOrDataRefresh();
 *   const rows = useMemo(() => getRows(), [refreshKey]);
 */
export function useFocusOrDataRefresh(): number {
  const dataVersion = useDataVersion();
  const [focusKey, setFocusKey] = useState(0);
  // setState lives in the focus effect (not render), so no render loop. Fires
  // once on mount (initial focus) and again on every refocus.
  useFocusEffect(useCallback(() => { setFocusKey(k => k + 1); }, []));
  return focusKey + dataVersion;
}
