import { useState, useCallback } from 'react';

/**
 * Reusable multi-select state for list screens.
 *
 * Long-press a row to `enter(id)` selection mode (optionally selecting the
 * long-pressed row); `toggle(id)` adds/removes a row; `selectAll(ids)` selects
 * a set of ids; `clear()` empties the selection without leaving mode; `exit()`
 * clears the selection and leaves selection mode.
 *
 * Pure UI state — no business logic. Reusable across users/jobs/inventory/etc.
 */
export interface MultiSelect {
  active: boolean;
  selected: Set<string>;
  count: number;
  isSelected: (id: string) => boolean;
  enter: (id?: string) => void;
  toggle: (id: string) => void;
  selectAll: (ids: string[]) => void;
  clear: () => void;
  exit: () => void;
}

export function useMultiSelect<T extends { id: string }>(): MultiSelect {
  const [active, setActive] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const isSelected = useCallback((id: string) => selected.has(id), [selected]);

  const enter = useCallback((id?: string) => {
    setActive(true);
    if (id) setSelected((prev) => new Set(prev).add(id));
  }, []);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback((ids: string[]) => {
    setSelected(new Set(ids));
  }, []);

  const clear = useCallback(() => {
    setSelected(new Set());
  }, []);

  const exit = useCallback(() => {
    setSelected(new Set());
    setActive(false);
  }, []);

  return {
    active,
    selected,
    count: selected.size,
    isSelected,
    enter,
    toggle,
    selectAll,
    clear,
    exit,
  };
}
