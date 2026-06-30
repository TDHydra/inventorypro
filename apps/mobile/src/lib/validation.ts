// Shared input parsing/validation for numeric form fields. Returns a tagged
// result so callers show a precise, fixable message instead of silently
// coercing bad input to 0 (the old `parseFloat(x) || 0` trap, which then
// complained "must be > 0" when the user actually typed "abc").

export type ParseResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

// Generous upper bound that still blocks fat-finger / overflow values
// (e.g. scientific-notation "1e308") from reaching stock math or the server.
export const MAX_QUANTITY = 1_000_000;

/** A positive stock quantity. Fractions allowed (0.5 gal). Rejects NaN/≤0/over-max. */
export function parseQuantity(input: string, label = 'Quantity'): ParseResult {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return { ok: false, error: `${label} is required.` };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return { ok: false, error: `${label} must be a number.` };
  if (n <= 0) return { ok: false, error: `${label} must be greater than zero.` };
  if (n > MAX_QUANTITY) return { ok: false, error: `${label} can’t exceed ${MAX_QUANTITY.toLocaleString()}.` };
  return { ok: true, value: n };
}

/**
 * An optional non-negative integer field (low-stock alert, reorder-to). Blank →
 * null (cleared). Rejects non-numeric / negative / non-integer input.
 */
export function parseOptionalCount(
  input: string,
  label = 'Value',
): { ok: true; value: number | null } | { ok: false; error: string } {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return { ok: true, value: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return { ok: false, error: `${label} must be a number.` };
  if (n < 0) return { ok: false, error: `${label} can’t be negative.` };
  if (!Number.isInteger(n)) return { ok: false, error: `${label} must be a whole number.` };
  if (n > MAX_QUANTITY) return { ok: false, error: `${label} can’t exceed ${MAX_QUANTITY.toLocaleString()}.` };
  return { ok: true, value: n };
}

/**
 * Optional pack size (units per pack). Blank → null. Must be a whole number > 1
 * to be meaningful (a pack of 1 is just the base unit).
 */
export function parsePackSize(
  input: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return { ok: true, value: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, error: 'Pack size must be a whole number.' };
  if (n <= 1) return { ok: false, error: 'Pack size must be greater than 1 (a pack of 1 is just the unit).' };
  if (n > MAX_QUANTITY) return { ok: false, error: `Pack size can’t exceed ${MAX_QUANTITY.toLocaleString()}.` };
  return { ok: true, value: n };
}
