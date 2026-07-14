// Shared input parsing/validation for numeric form fields. Returns a tagged
// result so callers show a precise, fixable message instead of silently
// coercing bad input to 0 (the old `parseFloat(x) || 0` trap, which then
// complained "must be > 0" when the user actually typed "abc").

import { MAX_BARCODE_LENGTH, sanitizeScan } from '../scan/sanitize';

export type ParseResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

export type StringResult =
  | { ok: true; value: string }
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
  if (!trimmed) return { ok: false, error: `${label} is required.` };
  if (CONTROL_CHARS.test(trimmed)) return { ok: false, error: `${label} contains unsupported characters.` };
  if (trimmed.length > maxLen) return { ok: false, error: `${label} can’t be longer than ${maxLen} characters.` };
  return { ok: true, value: trimmed };
}

// Pragmatic shape check (one @, no spaces, a dot in the domain) — real
// deliverability is the server's problem; this just catches typos early.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// RFC 5321 path limit.
const MAX_EMAIL_LENGTH = 254;

/** An email address. Trims, lowercases nothing (server normalizes). */
export function validateEmail(input: string): StringResult {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return { ok: false, error: 'Email is required.' };
  if (trimmed.length > MAX_EMAIL_LENGTH) return { ok: false, error: `Email can’t be longer than ${MAX_EMAIL_LENGTH} characters.` };
  if (!EMAIL_RE.test(trimmed)) return { ok: false, error: 'Enter a valid email address (like name@example.com).' };
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
      return { ok: false, error: `Barcode can’t be longer than ${MAX_BARCODE_LENGTH} characters.` };
    }
    return { ok: false, error: 'Barcode is required.' };
  }
  return { ok: true, value: cleaned };
}
