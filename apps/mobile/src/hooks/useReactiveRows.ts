import { useCallback, useEffect, useState } from 'react';
import { useDataVersion } from './useDataVersion';

// Two rows lists are equivalent when their id + updated_at sequence matches.
// Order-sensitive on purpose: a reorder IS a real change a list must reflect.
// This is what lets us hand a FlatList the SAME array reference across a no-op
// sync bump — a new reference mid-scroll drops the scroll responder and freezes
// the list until the next touch (board #91).
export function sameRows<T extends { id: string; updated_at?: string | null }>(
  a: readonly T[],
  b: readonly T[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false;
    if ((a[i].updated_at ?? null) !== (b[i].updated_at ?? null)) return false;
  }
  return true;
}

/**
 * The canonical way to back a list screen with local-DB rows that react to sync.
 *
 * Re-reads `read()` on every data-version bump (and via the returned `reload`),
 * but only swaps the array reference when the row set ACTUALLY changed. So a
 * screen reacts to real updates yet stays referentially stable across the many
 * unrelated writes that bump the global data-version — which is what keeps a
 * FlatList from re-rendering mid-scroll and freezing (board #91). Every list
 * screen that uses this is immune to that class of bug by construction; prefer
 * it over a hand-rolled `useState` + `useEffect(..., [dataVersion])` + `refresh`.
 *
 * `read` must be a stable reference (a module-level query fn, or memoized).
 */
export function useReactiveRows<T extends { id: string; updated_at?: string | null }>(
  read: () => T[],
): [T[], () => void] {
  const dataVersion = useDataVersion();
  const [rows, setRows] = useState<T[]>(read);

  const reload = useCallback(() => {
    const next = read();
    // Functional update returning `prev` on no-op → React bails the re-render,
    // so the FlatList never sees a new `data` reference for an unchanged list.
    setRows(prev => (sameRows(prev, next) ? prev : next));
  }, [read]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- reload is stable via `read`
  useEffect(() => { reload(); }, [dataVersion]);

  return [rows, reload];
}
