// Pure filter logic behind `RecordAutofillInput` — kept in a plain (non-.tsx)
// file with zero react/react-native imports so it can be unit-tested under
// node:test without pulling in RN's Flow-syntax internals via the tsx loader.
// Mirrors the QuantityStepper/quantityMath split.

export interface RecordOption<T> { label: string; sublabel?: string; record: T }

/** Case-insensitive `label` substring match; the exact current value is hidden
 * (nothing to offer once it already matches). Empty query returns everything
 * (capped), same as no-input-yet SuggestInput behavior. */
export function filterRecordOptions<T>(
  options: RecordOption<T>[],
  query: string,
  maxSuggestions: number,
): RecordOption<T>[] {
  const q = query.trim().toLowerCase();
  const pool = options.filter(o => o.label.toLowerCase() !== q); // hide exact match
  if (!q) return pool.slice(0, maxSuggestions);
  return pool.filter(o => o.label.toLowerCase().includes(q)).slice(0, maxSuggestions);
}
