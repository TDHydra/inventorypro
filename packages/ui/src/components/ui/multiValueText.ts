// #289: helpers for a free-text column that the crew treats as a LIST even
// though it is one TEXT column — `repairs.parts_needed` ("Fuel filter, Oil
// filter, 3/8 hose"). Pure so the segment arithmetic is testable without a
// TextInput, same split as levelStep (#285) and repairTargetLock (#288).
//
// Why a list at all, instead of a real join table: a repair's parts_needed is a
// SHOPPING list (what we have to go get), not consumption — the consumed side
// already has its own `repair_parts` rows written by "Use parts". Turning the
// wish list into rows would need a migration on both schema.ts AND
// schema.web.ts and would change what the API stores, for no gain the crew can
// see. So the column stays text and the FIELD gets smarter.
//
// The one rule everything here follows: the trailing segment is what the user
// is currently TYPING (the typeahead query), and everything before the last
// comma is already committed. That's what lets one input behave like a chip
// list without new UI.

/** What `appendSegment` writes between segments. Splitting accepts a bare ','. */
export const LIST_SEPARATOR = ', ';

/** Committed segments — everything before the trailing (in-progress) one. */
function committed(value: string): string[] {
  return value.split(',').slice(0, -1).map(seg => seg.trim()).filter(Boolean);
}

/** Every non-blank segment, in order, trimmed. `'a, b ,, c'` → `['a','b','c']`. */
export function splitList(value: string): string[] {
  return value.split(',').map(seg => seg.trim()).filter(Boolean);
}

/**
 * Canonical form for storage: blank segments dropped, single `, ` separator.
 * Call this before validating/saving so the trailing `', '` that `appendSegment`
 * leaves behind (deliberately — it's the "add another" affordance) never reaches
 * the DB.
 */
export function normalizeList(value: string): string {
  return splitList(value).join(LIST_SEPARATOR);
}

/** The in-progress trailing segment — the typeahead query. `'a, oil f'` → `'oil f'`. */
export function lastSegment(value: string): string {
  const parts = value.split(',');
  return parts[parts.length - 1].trim();
}

/** Is `candidate` already one of the committed-or-typed segments (case-insensitive)? */
export function listHas(value: string, candidate: string): boolean {
  const needle = candidate.trim().toLowerCase();
  if (!needle) return false;
  return splitList(value).some(seg => seg.toLowerCase() === needle);
}

/**
 * Commit `addition` as a segment, REPLACING the trailing in-progress one (which
 * was the query that surfaced it), and leave a trailing separator so the next
 * pick lands cleanly without the user typing a comma.
 *
 * `('Fuel filter, oil f', 'Oil filter')` → `'Fuel filter, Oil filter, '`
 *
 * Already-present segments are dropped rather than duplicated, so double-tapping
 * a suggestion is harmless.
 */
export function appendSegment(value: string, addition: string): string {
  const add = addition.trim();
  const kept = committed(value);
  const next = !add || kept.some(seg => seg.toLowerCase() === add.toLowerCase())
    ? kept
    : [...kept, add];
  return next.length > 0 ? next.join(LIST_SEPARATOR) + LIST_SEPARATOR : '';
}

/**
 * Suggestion pool for a `list`-mode field: each input value may itself BE a list
 * (a prior `parts_needed` row), so values are split into segments first, then
 * deduped case-insensitively with first-seen spelling and order preserved.
 * Order matters — callers put the authoritative source (the catalog) first so
 * the catalog's spelling wins over whatever someone typed by hand last month.
 */
export function dedupeSegments(values: string[]): string[] {
  return dedupeLabels(values.flatMap(splitList));
}

/** Trim + case-insensitive dedupe with first-seen spelling, no splitting. */
export function dedupeLabels(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = raw.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}
