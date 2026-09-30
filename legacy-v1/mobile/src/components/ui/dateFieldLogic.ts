// Pure mask/validate helpers for DateField.tsx, split into their own file
// (no React/React Native imports) so they're importable from a plain
// `node --test` run — react-native's Flow syntax breaks the tsx loader used
// by node:test, so nothing under this file's import graph may pull it in.

/** Digits 1-12 with the correct day count for that month, non-leap-year default. */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * True when `iso` is a real calendar date in strict `YYYY-MM-DD` form —
 * month 1-12, day valid for that month/year (leap years included). Deliberately
 * NOT delegated to `new Date(iso)`: engines roll invalid dates over instead of
 * rejecting them (`new Date('2026-02-30')` silently becomes March 1st), which
 * is exactly the bug this field needs to catch.
 */
export function isValidCalendarDate(iso: string): boolean {
  const m = ISO_DATE_RE.exec(iso);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  if (day < 1 || day > maxDay) return false;
  return true;
}

export interface DateValidation {
  ok: boolean;
  error?: string;
}

/**
 * Validates a completed `YYYY-MM-DD` string: real calendar date, then within
 * the inclusive `min`/`max` ISO bounds if given. ISO date strings of equal
 * length compare correctly with plain string comparison, so no Date parsing
 * is needed for the bounds check either.
 */
export function validateDateValue(iso: string, opts: { min?: string; max?: string } = {}): DateValidation {
  if (!isValidCalendarDate(iso)) {
    return { ok: false, error: 'Enter a valid date (YYYY-MM-DD).' };
  }
  if (opts.min && iso < opts.min) {
    return { ok: false, error: `Date can't be before ${opts.min}.` };
  }
  if (opts.max && iso > opts.max) {
    return { ok: false, error: `Date can't be after ${opts.max}.` };
  }
  return { ok: true };
}

/**
 * Masks free-typed input into `YYYY-MM-DD`: strips everything but digits
 * (so pasted dashes/slashes are harmless), caps at 8 digits, and auto-inserts
 * the two dashes as soon as enough digits exist for them (`2026` -> `2026-`,
 * `202607` -> `2026-07-`). `prev` is the field's current masked text; when the
 * caller passes it and the edit is a single trailing deletion that only
 * removed an auto-inserted dash (digit count unchanged), one more digit is
 * dropped too so backspace feels like it always removes a character.
 *
 * Known limitation: this heuristic has no cursor position (the caller
 * doesn't wire `onSelectionChange`), so it can't distinguish "backspaced
 * the trailing dash" from "backspaced a dash earlier in the string" — both
 * look like "digit count unchanged, one char shorter" and this always drops
 * the LAST digit rather than the one adjacent to the deleted dash. A correct
 * fix needs selection-aware editing; left as-is to keep this component's
 * dependency-free, position-less API.
 */
export function maskDateInput(raw: string, prev = ''): string {
  let digits = raw.replace(/\D/g, '').slice(0, 8);
  const prevDigits = prev.replace(/\D/g, '');
  if (raw.length < prev.length && digits.length === prevDigits.length && digits.length > 0) {
    digits = digits.slice(0, -1);
  }
  let out = digits.slice(0, 4);
  if (digits.length >= 4) out += '-';
  out += digits.slice(4, 6);
  if (digits.length >= 6) out += '-';
  out += digits.slice(6, 8);
  return out;
}

/** Formats a `Date` as a local-calendar `YYYY-MM-DD` string (no UTC shift). */
export function toIsoDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
