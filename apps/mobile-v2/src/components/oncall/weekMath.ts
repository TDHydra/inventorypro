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

/** Admin-configured week boundary: day-of-week (0=Sun…6=Sat) + local hour (0–23). */
export interface WeekBoundary { day: WeekStartsOn; hour: number }

/** Default per spec: on-call weeks flip Thursday 08:00 local. */
export const DEFAULT_WEEK_BOUNDARY: WeekBoundary = { day: 4, hour: 8 };

/** Tolerant parse of the app_config 'on_call_week_boundary' JSON. */
export function parseWeekBoundary(raw: string | null): WeekBoundary {
  if (!raw) return DEFAULT_WEEK_BOUNDARY;
  try {
    const p = JSON.parse(raw) as { day?: unknown; hour?: unknown };
    const day = Number(p.day);
    const hour = Number(p.hour);
    return {
      day: (Number.isInteger(day) && day >= 0 && day <= 6 ? day : DEFAULT_WEEK_BOUNDARY.day) as WeekStartsOn,
      hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_WEEK_BOUNDARY.hour,
    };
  } catch {
    return DEFAULT_WEEK_BOUNDARY;
  }
}

/**
 * Start date of the boundary week containing the local instant
 * (dateIso, hourOfDay). On the boundary day itself, hours BEFORE b.hour
 * still belong to the previous week.
 */
export function boundaryWeekStartIso(dateIso: string, hourOfDay: number, b: WeekBoundary): string {
  const base = weekStartIso(dateIso, b.day);
  return base === dateIso && hourOfDay < b.hour ? addDaysIso(base, -7) : base;
}

/**
 * Calendar-anchored rotation slot for a week: floor(epochDays/7) mod length.
 * Purely a function of the week date, so every device fills the SAME crew for
 * the same week (offline double-fill converges via the week_start upsert) and
 * a manual override of one week never shifts the others.
 */
export function rotationIndexForWeek(weekStartIso: string, rotationLength: number): number {
  if (rotationLength <= 0) return 0;
  const days = Math.round(toUtcDate(weekStartIso).getTime() / DAY_MS);
  const weekNo = Math.floor(days / 7);
  return ((weekNo % rotationLength) + rotationLength) % rotationLength;
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

// #184: moved here from OnCallCalendar.tsx so the schedule board's dayMath.ts
// can re-export it without pulling react-native into a pure/node-test-safe
// module's import graph (OnCallCalendar.tsx imports react-native; this file
// deliberately never does — see the file header). Unlike the rest of this
// file, these two read the device's LOCAL wall clock on purpose (day
// boundaries and "now" are wall-clock concepts, not UTC-normalized business
// keys) — deliberately not `toISOString().slice(0,10)`, which is UTC and
// flips to tomorrow in the evening for US timezones.

/** The device's LOCAL calendar date as YYYY-MM-DD. */
export function localTodayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** The device's LOCAL wall-clock hour (0–23). */
export function localNowHour(now: Date = new Date()): number {
  return now.getHours();
}
