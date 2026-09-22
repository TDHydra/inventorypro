import type { Theme } from '../themes/types';
import { useTheme } from './useTheme';

/**
 * Themed replacement for module-scope StyleSheet.create.
 *
 * Migration idiom per file:
 *   const makeStyles = (t: Theme) => StyleSheet.create({ ... });   // module scope
 *   const s = useThemedStyles(makeStyles);                          // in component
 *
 * The factory MUST be declared at module scope (stable identity) — it is the
 * cache key. Styles are built once per (factory, theme.id) for the app's
 * lifetime; theme switching is rare and themes are few, so entries are never
 * evicted.
 */
const cache = new WeakMap<(t: Theme) => unknown, Map<string, unknown>>();

export function useThemedStyles<T>(factory: (t: Theme) => T): T {
  const theme = useTheme();
  let byTheme = cache.get(factory);
  if (!byTheme) {
    byTheme = new Map();
    cache.set(factory, byTheme);
  }
  let styles = byTheme.get(theme.id);
  if (styles === undefined) {
    styles = factory(theme);
    byTheme.set(theme.id, styles);
  }
  return styles as T;
}
