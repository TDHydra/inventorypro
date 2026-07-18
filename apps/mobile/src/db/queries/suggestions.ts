import { getDb, rowsAs } from '../schema';

// Whitelisted (table, column) pairs eligible for free-text "you've typed this
// before" suggestions. `getDistinctColumnValues` interpolates table/column
// directly into SQL identifiers (SQLite can't bind identifiers as params), so
// this whitelist IS the injection barrier — same idiom as getDistinctValues in
// items.ts and distinctJobValues in jobs.ts, which this module is meant to
// eventually back (Wave C migrates those call sites; their exports are
// untouched here).
//
// Deliberately excluded: FK id columns (category_id, type_id, location_type).
// Those resolve through taxonomy.ts (resolveLabels) and belong in
// SelectField/TaxonomyChips, not free-text suggestions — a taxonomy rename
// must be reflected via the FK, not offered as a stale free-typed string.
// inventory_items category-label suggestions should keep going through the
// existing FK-resolving getDistinctValues('category') in items.ts.
//
// Columns verified against src/db/migrations/ before being added here:
// - inventory_items.sku/supplier/model: 002_inventory_fields.ts
// - inventory_items.unit: 001_initial.ts (NOT NULL)
// - jobs.customer_name/site_address: 008_job_workorder_fields.ts
// - jobs.insurance_carrier: 016_job_insurance.ts
// - jobs.reference_number: 013_hardening.ts
// - locations.name: 001_initial.ts (NOT NULL)
export const SUGGESTIBLE = {
  inventory_items: ['supplier', 'model', 'unit', 'sku'],
  jobs: ['customer_name', 'insurance_carrier', 'site_address', 'reference_number'],
  locations: ['name'],
} as const;

export type SuggestibleTable = keyof typeof SUGGESTIBLE;
export type SuggestibleColumn<T extends SuggestibleTable> = (typeof SUGGESTIBLE)[T][number];

// Distinct prior values for a whitelisted free-text column, for autocomplete
// suggestions ("previously typed this"). Case-insensitive sort, blanks
// excluded. Throws for any table/column not in SUGGESTIBLE — this is the only
// thing standing between this function and a SQL-injection-via-identifier bug,
// so the check runs before the table/column ever reach a query string.
export function getDistinctColumnValues<T extends SuggestibleTable>(
  table: T,
  column: SuggestibleColumn<T>,
): string[] {
  const columns: readonly string[] = SUGGESTIBLE[table] ?? [];
  if (!columns.includes(column)) {
    throw new Error(
      `getDistinctColumnValues: '${String(column)}' is not a suggestible column of '${String(table)}'`,
    );
  }
  const db = getDb();
  const result = db.executeSync(
    `SELECT DISTINCT ${column} AS v FROM ${table}
     WHERE ${column} IS NOT NULL AND TRIM(${column}) != '' ORDER BY v COLLATE NOCASE`,
  );
  return rowsAs<{ v: string }>(result.rows).map(r => r.v);
}
