import { useCallback, useEffect, useRef, useState } from 'react';
import { useTableVersion } from './useDataVersion';
import { getDistinctColumnValues } from '../db/queries/suggestions';
import type { SuggestibleColumn, SuggestibleTable } from '../db/queries/suggestions';

/**
 * Reactive free-text suggestions ("you've typed this before") for a
 * whitelisted table/column — the specialized counterpart to the general
 * `useDbQuery(fn, deps)` hook (backlog #63), scoped to
 * `getDistinctColumnValues`.
 *
 * Subscribes via `useTableVersion([table])` (#64's per-table granularity) so
 * a screen re-reads only when ITS table changes in a sync pull — not on every
 * unrelated write — and a newly synced value (e.g. a job's customer name)
 * shows up without remounting. Mirrors useReactiveRows' stability contract:
 * the returned array is the SAME reference across a re-render whose values
 * are unchanged (compared via `join(' ')`, per board #91 — a fresh reference
 * on every render is what froze a FlatList's scroll there).
 */
export function useSuggestions<T extends SuggestibleTable>(
  table: T,
  column: SuggestibleColumn<T>,
): string[] {
  const tableVersion = useTableVersion([table]);
  const [values, setValues] = useState<string[]>(() => getDistinctColumnValues(table, column));
  // Tracks the key of the array currently in state (not the values array
  // itself) so reload() can decide whether to swap the reference without
  // re-deriving it from `values`, which would defeat the point.
  const keyRef = useRef(values.join(' '));

  const reload = useCallback(() => {
    const next = getDistinctColumnValues(table, column);
    const nextKey = next.join(' ');
    if (nextKey === keyRef.current) return;
    keyRef.current = nextKey;
    setValues(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- table/column are the real deps
  }, [table, column]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- reload is stable via [table, column]
  useEffect(() => { reload(); }, [tableVersion, reload]);

  return values;
}
