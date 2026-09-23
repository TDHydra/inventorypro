// Pure day/time math for the employee schedule board (#184), split into its
// own file (no React/React Native imports) so it's importable from a plain
// `node --test` run — same discipline as ../oncall/weekMath.ts (react-native's
// Flow syntax breaks the tsx loader used by node:test, so nothing under this
// file's import graph may pull it in).
//
// `day` strings are plain 'YYYY-MM-DD' business-calendar keys (the scheduler's
// chosen day, not a device-TZ-derived instant — on_call_shifts.week_start
// precedent), so formatDayLabel parses them via Date.UTC like weekMath does,
// never `new Date(iso)` (which would apply the device's local TZ offset and
// can roll the date across midnight). start/end minutes are wall-clock
// minutes-since-midnight (0–1440) on that day, per the #184 data design.

export { addDaysIso, localTodayIso } from '../oncall/weekMath';

/** 8:00 AM — the board's visible workday window start (minutes since midnight). */
export const DAY_START_MIN = 480;
/** 5:00 PM — the board's visible workday window end (minutes since midnight). */
export const DAY_END_MIN = 1020;

// Expanded window (the "expand calendar" toggle) — 5:00 AM..9:00 PM, matching
// the assignable range the TimeWheelPicker offers (minMinute 300 / maxMinute
// 1260), so anything that CAN be scheduled fits on the expanded board.
export const EXPANDED_START_MIN = 300;
export const EXPANDED_END_MIN = 1260;

// Shared layout metrics for the timeline grid — one source of truth so the
// hour-label header (rendered once, in DayBoardScreen's `aboveList`) and each
// EmployeeScheduleRow's own hour cells can never drift out of column
// alignment with each other.
export const SLOT_ROW_LAYOUT = {
  /** Fixed-width employee name column, OUTSIDE each row's horizontal scroll. */
  nameColWidth: 96,
  /** Per-hour column width inside the scrollable track. */
  colWidth: 72,
  /** Number of hour columns spanning DAY_START_MIN..DAY_END_MIN. */
  hourCount: (DAY_END_MIN - DAY_START_MIN) / 60,
  /** Row height (also the header row's height, for alignment). */
  rowHeight: 56,
  /** Assignment chip height within a row (vertically centered). */
  chipHeight: 40,
};

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function toUtcDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Human label for a 'YYYY-MM-DD' day, e.g. "Tue, Aug 4". */
export function formatDayLabel(dateIso: string): string {
  const d = toUtcDate(dateIso);
  return `${WEEKDAYS_SHORT[d.getUTCDay()]}, ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** Human label for a minutes-since-midnight value, e.g. 540 -> "9:00 AM". */
export function formatMinute(min: number): string {
  const total = ((min % 1440) + 1440) % 1440;
  const h24 = Math.floor(total / 60);
  const m = total % 60;
  const period = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

/**
 * Pixel geometry for a chip spanning [startMin, endMin) within the visible
 * window (default DAY_START_MIN..DAY_END_MIN; the expand toggle passes the
 * EXPANDED_* window), given the per-hour column width. Ranges that fall
 * partly or fully outside the window are clamped to the nearest edge (never
 * negative left/width) — the UI renders a small off-window marker when
 * `clampedLeft`/`clampedRight` is true. The schema is minute-general; the
 * window is only a viewport.
 */
export function chipSpan(
  startMin: number,
  endMin: number,
  colWidth: number,
  windowStartMin: number = DAY_START_MIN,
  windowEndMin: number = DAY_END_MIN,
): { left: number; width: number; clampedLeft: boolean; clampedRight: boolean } {
  const pxPerMin = colWidth / 60;
  const clampedLeft = startMin < windowStartMin;
  const clampedRight = endMin > windowEndMin;
  const clStart = Math.max(startMin, windowStartMin);
  const clEnd = Math.min(endMin, windowEndMin);
  const left = (clStart - windowStartMin) * pxPerMin;
  const width = Math.max(0, (clEnd - clStart) * pxPerMin);
  return { left, width, clampedLeft, clampedRight };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function roundTo30(min: number): number {
  return Math.round(min / 30) * 30;
}

/**
 * Snaps a [start, end] pair to 30-minute increments, clamped to [0, 1440],
 * and guarantees `end > start` — pushing end forward (or, at the 1440 edge,
 * pulling start back) rather than swapping, since callers are a stepper UI
 * where the user is dragging one edge past the other.
 */
export function snapRange(startMin: number, endMin: number): [number, number] {
  let s = clamp(roundTo30(startMin), 0, 1440);
  let e = clamp(roundTo30(endMin), 0, 1440);
  if (e <= s) {
    e = Math.min(1440, s + 30);
    if (e <= s) s = Math.max(0, e - 30);
  }
  return [s, e];
}
