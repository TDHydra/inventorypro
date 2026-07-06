import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

/**
 * Returns a counter that increments each time the screen regains focus. Use it as
 * a dependency for `useMemo`/`useEffect` that read the local DB (taxonomy types,
 * locations, distinct values, …) so those reads REFRESH after a background sync
 * pull instead of staying frozen from first mount.
 *
 * Usage:
 *   const refreshKey = useFocusRefresh();
 *   const itemTypes = useMemo(() => getItemTypes(), [refreshKey]);
 *
 * Safe: setState lives in the focus effect (not render), so no render loop. It
 * fires once on mount (initial focus) and again on every refocus.
 */
export function useFocusRefresh(): number {
  const [key, setKey] = useState(0);
  useFocusEffect(useCallback(() => { setKey(k => k + 1); }, []));
  return key;
}
