// Pure month-grid / range-selection math for CalendarGrid.tsx and
// DateRangeField.tsx, split into its own file (no React/React Native imports)
// so it's importable from a plain `node --test` run — react-native's Flow
// syntax breaks the tsx loader used by node:test, so nothing under this
// file's import graph may pull it in. (Same pattern as dateFieldLogic.ts,
// quantityMath.ts and the on-call weekMath.ts.)
//
// Conventions match weekMath.ts: all functions operate on `YYYY-MM-DD`
// strings, Dates are constructed ONLY via `Date.UTC(...)` / getUTC*
// accessors (identical results in every device timezone, no DST drift),
// weeks default to Monday-start (`weekStartsOn = 1`), and range checks use
// plain string comparison — ISO dates of equal length compare correctly.
// Months are 1-based (1 = January) to match their ISO spelling.

import { isLeapYear, toIsoDateString } from './dateFieldLogic';

/** 0 = Sunday … 6 = Saturday, matching `Date#getUTCDay` (and weekMath.ts). */
export type WeekStartsOn = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const DAY_MS = 24 * 60 * 60 * 1000;

const MONTHS_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const WEEKDAYS_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function toUtcDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtcDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDaysIso(dateIso: string, days: number): string {
  return fromUtcDate(new Date(toUtcDate(dateIso).getTime() + days * DAY_MS));
}

/** Day count of a (1-based) month, leap-February included. */
export function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
}

/** One cell of the month grid. `inMonth` is false for adjacent-month padding days. */
export interface DayCell {
  iso: string;      // 'YYYY-MM-DD'
  day: number;      // 1-31, the day-of-month of `iso` (NOT of the grid's month)
  inMonth: boolean; // true when the cell belongs to the requested month
}

/**
 * Full calendar grid for a (1-based) month: an array of whole weeks, each
 * exactly 7 `DayCell`s. The first week is padded backwards to the nearest
 * week-start day and the last forwards to complete the week, using real
 * adjacent-month dates (flagged `inMonth: false`) rather than blanks so
 * every cell stays tappable and the row math stays trivial.
 */
export function monthGrid(year: number, month: number, weekStartsOn: WeekStartsOn = 1): DayCell[][] {
  const firstIso = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastIso = addDaysIso(firstIso, daysInMonth(year, month) - 1);
  // Walk back from the 1st to the week-start day (same diff as weekMath.weekStartIso).
  const leading = (toUtcDate(firstIso).getUTCDay() - weekStartsOn + 7) % 7;
  let cursor = addDaysIso(firstIso, -leading);

  const weeks: DayCell[][] = [];
  // Keep emitting whole weeks until the month's last day has been covered.
  while (weeks.length === 0 || weeks[weeks.length - 1][6].iso < lastIso) {
    const week: DayCell[] = [];
    for (let i = 0; i < 7; i++) {
      week.push({
        iso: cursor,
        day: Number(cursor.slice(8, 10)),
        inMonth: cursor >= firstIso && cursor <= lastIso,
      });
      cursor = addDaysIso(cursor, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/** The month before (1-based), rolling over the year boundary. */
export function prevMonth(year: number, month: number): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

/** The month after (1-based), rolling over the year boundary. */
export function nextMonth(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

/** Year + (1-based) month of a `YYYY-MM-DD` string. */
export function monthFromIso(iso: string): { year: number; month: number } {
  return { year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) };
}

/** Header label for a grid month, e.g. `"July 2026"`. */
export function monthLabel(year: number, month: number): string {
  return `${MONTHS_FULL[month - 1]} ${year}`;
}

/** Weekday header row for the grid, rotated to start on `weekStartsOn`. */
export function weekdayLabels(weekStartsOn: WeekStartsOn = 1): string[] {
  return Array.from({ length: 7 }, (_, i) => WEEKDAYS_SHORT[(weekStartsOn + i) % 7]);
}

/** True when `iso` lies inside the inclusive [start, end] range; false while either endpoint is unset. */
export function inRange(iso: string, start: string | null, end: string | null): boolean {
  return !!start && !!end && iso >= start && iso <= end;
}

/** True when `iso` is exactly the range start. */
export function isRangeStart(iso: string, start: string | null): boolean {
  return !!start && iso === start;
}

/** True when `iso` is exactly the range end. */
export function isRangeEnd(iso: string, end: string | null): boolean {
  return !!end && iso === end;
}

export interface DateRange {
  start: string | null;
  end: string | null;
}

/**
 * Two-tap range selection: with nothing selected, a tap sets the start; with
 * only a start, a tap on/after it completes the range (same day = one-day
 * range) while a tap BEFORE it restarts from the tapped day; with a complete
 * range, any tap restarts. Pure — the caller owns the state.
 */
export function nextRangeSelection(current: DateRange, tappedIso: string): DateRange {
  if (current.start && !current.end && tappedIso >= current.start) {
    return { start: current.start, end: tappedIso };
  }
  return { start: tappedIso, end: null };
}

/** Local today as `YYYY-MM-DD` (device calendar day, not UTC). */
export function todayIso(): string {
  return toIsoDateString(new Date());
}
