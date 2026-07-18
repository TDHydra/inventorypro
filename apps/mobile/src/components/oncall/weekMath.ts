// Pure week math for the on-call calendar (#128), split into its own file
// (no React/React Native imports) so it's importable from a plain
// `node --test` run — react-native's Flow syntax breaks the tsx loader used
// by node:test, so nothing under this file's import graph may pull it in.
//
// All functions operate on `YYYY-MM-DD` strings and construct Dates ONLY via
// `Date.UTC(...)` / the getUTC* accessors, so results are identical in every
// device timezone and never shift across DST transitions (a local-time
// `new Date(y, m, d)` + `setDate` walk can land on 23h/25h days). ISO date
// strings of equal length compare correctly as plain strings, so range checks
// need no Date parsing at all. `on_call_shifts.week_start` stores exactly
// these strings (UNIQUE per week), so canonicalization here IS the conflict
// target on the server.

/** 0 = Sunday … 6 = Saturday, matching `Date#getUTCDay`. */
export type WeekStartsOn = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const DAY_MS = 24 * 60 * 60 * 1000;

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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

/** Adds `days` (may be negative) to a `YYYY-MM-DD` string, calendar-correct across month/year boundaries. */
export function addDaysIso(dateIso: string, days: number): string {
  return fromUtcDate(new Date(toUtcDate(dateIso).getTime() + days * DAY_MS));
}

/**
 * ISO date of the start of the week containing `dateIso`. Defaults to
 * Monday-start weeks (`weekStartsOn = 1`), the canonical form stored in
 * `on_call_shifts.week_start`. A date already on the week-start day maps to
 * itself.
 */
export function weekStartIso(dateIso: string, weekStartsOn: WeekStartsOn = 1): string {
  const d = toUtcDate(dateIso);
  const diff = (d.getUTCDay() - weekStartsOn + 7) % 7;
  return addDaysIso(dateIso, -diff);
}

/**
 * Consecutive week-start ISO dates, always in ascending order, each 7 days
 * apart. `fromIso` is first normalized to its week start. `count > 0` yields
 * that week and the `count - 1` following weeks; `count < 0` yields the
 * `|count|` weeks ENDING at that week (inclusive) — i.e. backwards in time
 * but still returned ascending. `count === 0` yields `[]`.
 */
export function enumerateWeeks(fromIso: string, count: number, weekStartsOn: WeekStartsOn = 1): string[] {
  if (count === 0) return [];
  const start = weekStartIso(fromIso, weekStartsOn);
  const n = Math.abs(count);
  const firstOffset = count > 0 ? 0 : -(n - 1);
  const weeks: string[] = [];
  for (let i = 0; i < n; i++) {
    weeks.push(addDaysIso(start, (firstOffset + i) * 7));
  }
  return weeks;
}

/**
 * True when `todayIso` falls inside the 7-day week beginning at
 * `weekStartIso` (inclusive start, exclusive start+7). 'Today' is a parameter
 * — not read from the clock — so callers pass their own notion of now and the
 * function stays pure/testable. Plain string comparison is sufficient for ISO
 * dates of equal length.
 */
export function isCurrentWeek(weekStartIso: string, todayIso: string): boolean {
  return todayIso >= weekStartIso && todayIso < addDaysIso(weekStartIso, 7);
}

/**
 * Human label for the 7-day week starting at `weekStartIso`, e.g.
 * `"Jul 13 – 19"` within one month, `"Jun 29 – Jul 5"` across months
 * (including across a year boundary: `"Dec 29 – Jan 4"`).
 */
export function formatWeekRange(weekStartIso: string): string {
  const start = toUtcDate(weekStartIso);
  const end = toUtcDate(addDaysIso(weekStartIso, 6));
  const startLabel = `${MONTHS_SHORT[start.getUTCMonth()]} ${start.getUTCDate()}`;
  if (start.getUTCMonth() === end.getUTCMonth() && start.getUTCFullYear() === end.getUTCFullYear()) {
    return `${startLabel} – ${end.getUTCDate()}`;
  }
  return `${startLabel} – ${MONTHS_SHORT[end.getUTCMonth()]} ${end.getUTCDate()}`;
}
