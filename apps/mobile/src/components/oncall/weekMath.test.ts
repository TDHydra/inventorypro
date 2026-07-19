import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDaysIso,
  weekStartIso,
  enumerateWeeks,
  isCurrentWeek,
  formatWeekRange,
  parseWeekBoundary,
  boundaryWeekStartIso,
  rotationIndexForWeek,
  DEFAULT_WEEK_BOUNDARY,
} from './weekMath';

// ---------------------------------------------------------------- addDaysIso

test('addDaysIso: adds within a month', () => {
  assert.equal(addDaysIso('2026-07-13', 3), '2026-07-16');
});

test('addDaysIso: crosses a month boundary', () => {
  assert.equal(addDaysIso('2026-06-29', 7), '2026-07-06');
});

test('addDaysIso: negative days cross a year boundary backwards', () => {
  assert.equal(addDaysIso('2026-01-01', -1), '2025-12-31');
});

test('addDaysIso: handles leap day', () => {
  assert.equal(addDaysIso('2024-02-28', 1), '2024-02-29');
  assert.equal(addDaysIso('2024-02-29', 1), '2024-03-01');
});

// -------------------------------------------------------------- weekStartIso

test('weekStartIso: mid-week date maps to its Monday', () => {
  // 2026-07-18 is a Saturday
  assert.equal(weekStartIso('2026-07-18'), '2026-07-13');
});

test('weekStartIso: a Monday maps to itself', () => {
  assert.equal(weekStartIso('2026-07-13'), '2026-07-13');
});

test('weekStartIso: Sunday belongs to the PREVIOUS Monday-start week', () => {
  // 2026-07-19 is a Sunday
  assert.equal(weekStartIso('2026-07-19'), '2026-07-13');
});

test('weekStartIso: weekStartsOn=0 (Sunday-start weeks)', () => {
  // Saturday 2026-07-18 -> Sunday 2026-07-12; Sunday maps to itself
  assert.equal(weekStartIso('2026-07-18', 0), '2026-07-12');
  assert.equal(weekStartIso('2026-07-12', 0), '2026-07-12');
});

test('weekStartIso: year boundary — New Year week starts in the old year', () => {
  // 2026-01-01 is a Thursday -> Monday 2025-12-29
  assert.equal(weekStartIso('2026-01-01'), '2025-12-29');
  assert.equal(weekStartIso('2025-12-31'), '2025-12-29');
});

test('weekStartIso: DST spring-forward Sunday (US 2026-03-08) is TZ-stable', () => {
  // 2026-03-08 is the second Sunday of March (US DST start), a Sunday
  assert.equal(weekStartIso('2026-03-08'), '2026-03-02');
  assert.equal(weekStartIso('2026-03-09'), '2026-03-09'); // Monday after
});

test('weekStartIso: DST fall-back Sunday (US 2026-11-01) is TZ-stable', () => {
  // 2026-11-01 is the first Sunday of November (US DST end)
  assert.equal(weekStartIso('2026-11-01'), '2026-10-26');
  assert.equal(weekStartIso('2026-11-02'), '2026-11-02'); // Monday after
});

// ------------------------------------------------------------ enumerateWeeks

test('enumerateWeeks: forward from a mid-week date, normalized to week starts', () => {
  assert.deepEqual(enumerateWeeks('2026-07-18', 3), ['2026-07-13', '2026-07-20', '2026-07-27']);
});

test('enumerateWeeks: negative count enumerates backwards, returned ascending', () => {
  assert.deepEqual(enumerateWeeks('2026-07-18', -3), ['2026-06-29', '2026-07-06', '2026-07-13']);
});

test('enumerateWeeks: count 0 yields empty; count 1 yields just the week', () => {
  assert.deepEqual(enumerateWeeks('2026-07-18', 0), []);
  assert.deepEqual(enumerateWeeks('2026-07-18', 1), ['2026-07-13']);
  assert.deepEqual(enumerateWeeks('2026-07-18', -1), ['2026-07-13']);
});

test('enumerateWeeks: spans a year boundary forward', () => {
  assert.deepEqual(enumerateWeeks('2025-12-22', 3), ['2025-12-22', '2025-12-29', '2026-01-05']);
});

test('enumerateWeeks: weeks stay exactly 7 days apart across the DST transition', () => {
  assert.deepEqual(enumerateWeeks('2026-03-02', 3), ['2026-03-02', '2026-03-09', '2026-03-16']);
  assert.deepEqual(enumerateWeeks('2026-10-26', 3), ['2026-10-26', '2026-11-02', '2026-11-09']);
});

test('enumerateWeeks: respects weekStartsOn', () => {
  assert.deepEqual(enumerateWeeks('2026-07-18', 2, 0), ['2026-07-12', '2026-07-19']);
});

// ------------------------------------------------------------- isCurrentWeek

test('isCurrentWeek: today inside the week (inclusive start)', () => {
  assert.equal(isCurrentWeek('2026-07-13', '2026-07-13'), true);
  assert.equal(isCurrentWeek('2026-07-13', '2026-07-18'), true);
});

test('isCurrentWeek: last day of the week is in, first day of next week is out', () => {
  assert.equal(isCurrentWeek('2026-07-13', '2026-07-19'), true);
  assert.equal(isCurrentWeek('2026-07-13', '2026-07-20'), false);
});

test('isCurrentWeek: today before the week is out', () => {
  assert.equal(isCurrentWeek('2026-07-13', '2026-07-12'), false);
});

test('isCurrentWeek: works across a year boundary', () => {
  assert.equal(isCurrentWeek('2025-12-29', '2026-01-01'), true);
  assert.equal(isCurrentWeek('2025-12-29', '2026-01-05'), false);
});

// ----------------------------------------------------------- formatWeekRange

test('formatWeekRange: within one month', () => {
  assert.equal(formatWeekRange('2026-07-13'), 'Jul 13 – 19');
});

test('formatWeekRange: across a month boundary', () => {
  assert.equal(formatWeekRange('2026-06-29'), 'Jun 29 – Jul 5');
});

test('formatWeekRange: across a year boundary', () => {
  assert.equal(formatWeekRange('2025-12-29'), 'Dec 29 – Jan 4');
});

// --------------------------------------------------------- parseWeekBoundary

test('parseWeekBoundary: null/malformed/out-of-range → Thursday 08:00 default', () => {
  assert.deepEqual(parseWeekBoundary(null), { day: 4, hour: 8 });
  assert.deepEqual(parseWeekBoundary('not json'), { day: 4, hour: 8 });
  assert.deepEqual(parseWeekBoundary('{"day":9,"hour":-1}'), { day: 4, hour: 8 });
  assert.deepEqual(parseWeekBoundary('{"day":1,"hour":0}'), { day: 1, hour: 0 });
});

// ------------------------------------------------------ boundaryWeekStartIso

test('boundaryWeekStartIso: mid-week date maps to its Thursday', () => {
  // 2026-07-18 is a Saturday; the Thursday of that boundary week is 2026-07-16
  assert.equal(boundaryWeekStartIso('2026-07-18', 12, DEFAULT_WEEK_BOUNDARY), '2026-07-16');
  // Wednesday belongs to the PREVIOUS Thursday-start week
  assert.equal(boundaryWeekStartIso('2026-07-15', 12, DEFAULT_WEEK_BOUNDARY), '2026-07-09');
});

test('boundaryWeekStartIso: on the boundary day, the hour decides the week', () => {
  // Thursday 2026-07-16 at 07:59 → still last week; at 08:00 → new week
  assert.equal(boundaryWeekStartIso('2026-07-16', 7, DEFAULT_WEEK_BOUNDARY), '2026-07-09');
  assert.equal(boundaryWeekStartIso('2026-07-16', 8, DEFAULT_WEEK_BOUNDARY), '2026-07-16');
});

test('boundaryWeekStartIso: Monday boundary at hour 0 degrades to plain weekStartIso', () => {
  assert.equal(boundaryWeekStartIso('2026-07-13', 0, { day: 1, hour: 0 }), '2026-07-13');
  assert.equal(boundaryWeekStartIso('2026-07-19', 23, { day: 1, hour: 0 }), '2026-07-13');
});

// ------------------------------------------------------- rotationIndexForWeek

test('rotationIndexForWeek: consecutive weeks get consecutive indices mod length', () => {
  const i0 = rotationIndexForWeek('2026-07-16', 3);
  assert.equal(rotationIndexForWeek('2026-07-23', 3), (i0 + 1) % 3);
  assert.equal(rotationIndexForWeek('2026-07-30', 3), (i0 + 2) % 3);
  assert.equal(rotationIndexForWeek('2026-08-06', 3), i0); // full cycle
});

test('rotationIndexForWeek: deterministic (calendar-anchored) and safe on length<=0', () => {
  assert.equal(rotationIndexForWeek('2026-07-16', 2), rotationIndexForWeek('2026-07-16', 2));
  assert.equal(rotationIndexForWeek('2026-07-16', 0), 0);
});
