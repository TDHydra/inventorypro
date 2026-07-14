// Shared input parsing/validation for numeric form fields. Returns a tagged
// result so callers show a precise, fixable message instead of silently
// coercing bad input to 0 (the old `parseFloat(x) || 0` trap, which then
// complained "must be > 0" when the user actually typed "abc").

import { MAX_BARCODE_LENGTH, sanitizeScan } from '../scan/sanitize';

// `rule` is a machine-readable rejection reason for telemetry
// (track('audit','validation_reject',{field,rule})) — NEVER the entered value.
export type ParseResult =
  | { ok: true; value: number }
  | { ok: false; error: string; rule: string };

export type StringResult =
  | { ok: true; value: string }
  | { ok: false; error: string; rule: string };

// Generous upper bound that still blocks fat-finger / overflow values
// (e.g. scientific-notation "1e308") from reaching stock math or the server.
export const MAX_QUANTITY = 1_000_000;

/** A positive stock quantity. Fractions allowed (0.5 gal). Rejects NaN/≤0/over-max. */
export function parseQuantity(input: string, label = 'Quantity'): ParseResult {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return { ok: false, error: `${label} is required.`, rule: 'required' };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return { ok: false, error: `${label} must be a number.`, rule: 'nan' };
  if (n <= 0) return { ok: false, error: `${label} must be greater than zero.`, rule: 'min' };
  if (n > MAX_QUANTITY) return { ok: false, error: `${label} can’t exceed ${MAX_QUANTITY.toLocaleString()}.`, rule: 'max' };
  return { ok: true, value: n };
}

/**
 * An optional non-negative integer field (low-stock alert, reorder-to). Blank →
 * null (cleared). Rejects non-numeric / negative / non-integer input.
 */
export function parseOptionalCount(
  input: string,
  label = 'Value',
): { ok: true; value: number | null } | { ok: false; error: string; rule: string } {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return { ok: true, value: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return { ok: false, error: `${label} must be a number.`, rule: 'nan' };
  if (n < 0) return { ok: false, error: `${label} can’t be negative.`, rule: 'negative' };
  if (!Number.isInteger(n)) return { ok: false, error: `${label} must be a whole number.`, rule: 'integer' };
  if (n > MAX_QUANTITY) return { ok: false, error: `${label} can’t exceed ${MAX_QUANTITY.toLocaleString()}.`, rule: 'max' };
  return { ok: true, value: n };
}

/**
 * Optional pack size (units per pack). Blank → null. Must be a whole number > 1
 * to be meaningful (a pack of 1 is just the base unit).
 */
export function parsePackSize(
  input: string,
): { ok: true; value: number | null } | { ok: false; error: string; rule: string } {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return { ok: true, value: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, error: 'Pack size must be a whole number.', rule: 'integer' };
  if (n <= 1) return { ok: false, error: 'Pack size must be greater than 1 (a pack of 1 is just the unit).', rule: 'min' };
  if (n > MAX_QUANTITY) return { ok: false, error: `Pack size can’t exceed ${MAX_QUANTITY.toLocaleString()}.`, rule: 'max' };
  return { ok: true, value: n };
}

// ASCII control chars (NUL..US plus DEL) — same denylist as scan/sanitize.ts.
// Built from escapes (not literal bytes) so the source stays plain-ASCII.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('[\\x00-\\x1F\\x7F]');

/**
 * A required free-text name (item, team, location, …). Trims whitespace and
 * rejects control characters instead of silently stripping them — a name with
 * embedded NUL/escape bytes is a paste or scanner accident the user should see.
 */
export function validateName(
  input: string,
  { label = 'Name', maxLen = 200 }: { label?: string; maxLen?: number } = {},
): StringResult {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return { ok: false, error: `${label} is required.`, rule: 'required' };
  if (CONTROL_CHARS.test(trimmed)) return { ok: false, error: `${label} contains unsupported characters.`, rule: 'control_chars' };
  if (trimmed.length > maxLen) return { ok: false, error: `${label} can’t be longer than ${maxLen} characters.`, rule: 'max_length' };
  return { ok: true, value: trimmed };
}

// Like CONTROL_CHARS but permits tab/newline/CR — multiline notes and
// descriptions legitimately contain them.
// eslint-disable-next-line no-control-regex
const TEXT_CONTROL_CHARS = new RegExp('[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]');

/**
 * An OPTIONAL free-text field (description, notes, serial, address, …). Blank
 * is fine (→ ''; callers keep their `value || null` convention). Rejects
 * control characters (except tab/newline) and over-length input instead of
 * silently truncating. Returns the trimmed value.
 */
export function validateText(
  input: string,
  { label = 'Text', max = 2000 }: { label?: string; max?: number } = {},
): StringResult {
  const trimmed = (input ?? '').trim();
  if (TEXT_CONTROL_CHARS.test(trimmed)) return { ok: false, error: `${label} contains unsupported characters.`, rule: 'control_chars' };
  if (trimmed.length > max) return { ok: false, error: `${label} can’t be longer than ${max} characters.`, rule: 'max_length' };
  return { ok: true, value: trimmed };
}

/**
 * Stock quantity for the Delta/Set quick-add flows. Preserves the historical
 * parseFloat leniency and error copy exactly ('delta' additions must be > 0; a
 * 'set' recount may be 0), adding only the previously missing overflow bound
 * (parseFloat('1e999') → Infinity passed the old isNaN check).
 */
export function parseStockQuantity(input: string, mode: 'delta' | 'set'): ParseResult {
  const trimmed = (input ?? '').trim();
  const n = Number.parseFloat(trimmed);
  const belowFloor = mode === 'delta' ? n <= 0 : n < 0;
  if (!trimmed || Number.isNaN(n) || belowFloor) {
    return {
      ok: false,
      error: mode === 'delta' ? 'Quantity must be greater than 0.' : 'Quantity must be 0 or greater.',
      rule: !trimmed ? 'required' : Number.isNaN(n) ? 'nan' : 'min',
    };
  }
  if (!Number.isFinite(n) || n > MAX_QUANTITY) {
    return { ok: false, error: `Quantity can’t exceed ${MAX_QUANTITY.toLocaleString()}.`, rule: 'max' };
  }
  return { ok: true, value: n };
}

/**
 * An optional non-negative amount (purchase price, repair/maintenance cost).
 * Blank → null (cleared). Bounded so overflow values never reach money math.
 */
export function parseOptionalNonNegative(
  input: string,
  label = 'Amount',
): { ok: true; value: number | null } | { ok: false; error: string; rule: string } {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return { ok: true, value: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return { ok: false, error: `${label} must be a number.`, rule: 'nan' };
  if (n < 0) return { ok: false, error: `${label} can’t be negative.`, rule: 'negative' };
  if (n > MAX_QUANTITY) return { ok: false, error: `${label} can’t exceed ${MAX_QUANTITY.toLocaleString()}.`, rule: 'max' };
  return { ok: true, value: n };
}

/**
 * An optional date field (YYYY-MM-DD or anything Date can parse). Blank → null
 * (cleared). Invalid input is rejected instead of silently coerced to null —
 * the user typed SOMETHING, so dropping it would lose data without a word.
 * Returns a full ISO instant.
 */
export function parseOptionalDate(
  input: string,
  label = 'Date',
): { ok: true; value: string | null } | { ok: false; error: string; rule: string } {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return { ok: true, value: null };
  const d = new Date(trimmed);
  if (isNaN(d.getTime())) return { ok: false, error: `${label} isn’t a valid date (use YYYY-MM-DD).`, rule: 'date' };
  return { ok: true, value: d.toISOString() };
}

// Pragmatic shape check (one @, no spaces, a dot in the domain) — real
// deliverability is the server's problem; this just catches typos early.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// RFC 5321 path limit.
const MAX_EMAIL_LENGTH = 254;

/** An email address. Trims, lowercases nothing (server normalizes). */
export function validateEmail(input: string): StringResult {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return { ok: false, error: 'Email is required.', rule: 'required' };
  if (trimmed.length > MAX_EMAIL_LENGTH) return { ok: false, error: `Email can’t be longer than ${MAX_EMAIL_LENGTH} characters.`, rule: 'max_length' };
  if (!EMAIL_RE.test(trimmed)) return { ok: false, error: 'Enter a valid email address (like name@example.com).', rule: 'format' };
  return { ok: true, value: trimmed };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the string is a canonical hyphenated UUID (any version). */
export function isUuid(input: string): boolean {
  return typeof input === 'string' && UUID_RE.test(input);
}

/**
 * A barcode/QR value typed or scanned into a form. Delegates to the scan-path
 * sanitizer (control-char strip + trim + length bound) so both entry points
 * accept exactly the same values.
 */
export function validateBarcode(input: string): StringResult {
  const cleaned = sanitizeScan(input);
  if (cleaned === null) {
    if (((input ?? '').trim()).length > MAX_BARCODE_LENGTH) {
      return { ok: false, error: `Barcode can’t be longer than ${MAX_BARCODE_LENGTH} characters.`, rule: 'max_length' };
    }
    return { ok: false, error: 'Barcode is required.', rule: 'required' };
  }
  return { ok: true, value: cleaned };
}
