// Pure taxonomy label-resolution helper for the label→FK cutover (#74, Phase 2).
// Kept DB-free (no ../schema import) so it is unit-testable under `node --test`
// without the native op-sqlite module. taxonomy.ts builds the id→label map from
// the DB and delegates the row rewrite here.

// For each row, if row[idField] is a non-empty string AND present in `map`,
// overwrite row[labelField] with the current label; otherwise leave the cached
// label (grace for null/unknown ids). Mutates in place — callers pass fresh
// rowsAs() objects, so this is safe.
// T is unconstrained (entity rows are `interface`s, which TS won't assign to a
// Record<string, unknown> constraint) — we cast each row internally instead.
export function applyLabelMap<T>(
  rows: T[],
  idField: string,
  labelField: string,
  map: Map<string, string>,
): T[] {
  for (const row of rows) {
    const rec = row as Record<string, unknown>;
    const id = rec[idField];
    if (typeof id === 'string' && id) {
      const label = map.get(id);
      if (label != null) rec[labelField] = label;
    }
  }
  return rows;
}
