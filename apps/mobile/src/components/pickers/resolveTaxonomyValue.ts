// Pure, DB-FREE id↔label resolution for TaxonomyPicker. Kept free of any
// taxonomy.ts / db/schema import (those pull native op-sqlite, which cannot load
// under `node --test`) so this stays unit-testable. Modeled on ./../../db/queries/labelResolve.ts.
//
// #74 is mid-migration: an entity may carry a soft-FK id (type_id) OR a
// denormalized label (type), or both. TaxonomyPicker exposes both and must never
// drop a value it can't resolve — a job may hold the label of an archived type
// whose row no longer appears in the active list.

export interface TaxonomyValue {
  id: string | null;
  label: string | null;
}

// Resolve a stored (valueId, valueLabel) against the current type list.
// Precedence: an id that matches a type wins (returns that type's id+label);
// else a label that matches a type's label (case-sensitive, as the screens do
// today) returns that type's id+label; else the raw value survives unresolved
// so an archived/unknown value is never silently discarded.
export function resolveTaxonomyValue(
  types: ReadonlyArray<{ id: string; label: string }>,
  valueId?: string | null,
  valueLabel?: string | null,
): TaxonomyValue {
  if (valueId) {
    const byId = types.find(t => t.id === valueId);
    if (byId) return { id: byId.id, label: byId.label };
  }
  if (valueLabel) {
    const byLabel = types.find(t => t.label === valueLabel);
    if (byLabel) return { id: byLabel.id, label: byLabel.label };
  }
  return { id: valueId ?? null, label: valueLabel ?? null };
}

// The default selection when a screen wants today's `getTaxonomyTypes(cat)[0]`
// behavior (defaultToFirst): first type, or an empty value when none exist.
export function defaultTaxonomyValue(
  types: ReadonlyArray<{ id: string; label: string }>,
): TaxonomyValue {
  const first = types[0];
  return first ? { id: first.id, label: first.label } : { id: null, label: null };
}
