// #140: loc-context scoping for the hub's fast-checkout browse/search. The
// source location must never HIDE catalog items — a fresh vehicle/locker has no
// stock_by_location rows yet, and a hard filter turned the whole catalog into
// an empty list. Instead, partition: what's at the source leads (so "grab it
// here" stays one tap), the rest of the catalog follows. Write safety is the
// commit-time "Not enough here" quantity guard, not visibility.
// Pure (no React/DB imports) so it unit-tests in plain Node.

export interface SourceScoped<T> {
  /** Items with positive stock at the source, input order preserved. */
  atSource: T[];
  /** The rest of the catalog, input order preserved. */
  elsewhere: T[];
}

export function partitionBySourceStock<T extends { id: string }>(
  items: readonly T[],
  qtyByItemId: ReadonlyMap<string, number>,
): SourceScoped<T> {
  const atSource: T[] = [];
  const elsewhere: T[] = [];
  for (const item of items) {
    if ((qtyByItemId.get(item.id) ?? 0) > 0) atSource.push(item);
    else elsewhere.push(item);
  }
  return { atSource, elsewhere };
}
