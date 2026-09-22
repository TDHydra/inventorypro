import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  daysInMonth,
  monthGrid,
  monthFromIso,
  monthLabel,
  prevMonth,
  nextMonth,
  inRange,
  isRangeStart,
  isRangeEnd,
  nextRangeSelection,
  todayIso,
} from './calendarMath';

// --- daysInMonth ---------------------------------------------------------

test('daysInMonth: 31-day month', () => {
  assert.equal(daysInMonth(2026, 7), 31);
});

test('daysInMonth: February on a non-leap year', () => {
  assert.equal(daysInMonth(2026, 2), 28);
});

test('daysInMonth: February on a leap year', () => {
  assert.equal(daysInMonth(2024, 2), 29);
});

test('daysInMonth: 30-day month', () => {
  assert.equal(daysInMonth(2026, 4), 30);
});

// --- monthGrid -----------------------------------------------------------

test('monthGrid: every week has exactly 7 cells', () => {
  const weeks = monthGrid(2026, 7);
  assert.ok(weeks.length >= 4 && weeks.length <= 6);
  for (const week of weeks) assert.equal(week.length, 7);
});

test('monthGrid: July 2026 (Monday start) leads with adjacent June days', () => {
  // 2026-07-01 is a Wednesday, so a Monday-start grid begins on Jun 29.
  const weeks = monthGrid(2026, 7);
  assert.equal(weeks[0][0].iso, '2026-06-29');
  assert.equal(weeks[0][0].inMonth, false);
  assert.equal(weeks[0][2].iso, '2026-07-01');
  assert.equal(weeks[0][2].inMonth, true);
});

test('monthGrid: July 2026 trails into August to fill the last week', () => {
  const weeks = monthGrid(2026, 7);
  const last = weeks[weeks.length - 1];
  assert.equal(last[6].iso, '2026-08-02');
  assert.equal(last[6].inMonth, false);
  assert.equal(weeks.length, 5);
});

test('monthGrid: day numbers match the ISO date', () => {
  const weeks = monthGrid(2026, 7);
  for (const week of weeks) {
    for (const cell of week) {
      assert.equal(cell.day, Number(cell.iso.slice(8, 10)));
      assert.match(cell.iso, /^\d{4}-\d{2}-\d{2}$/);
    }
  }
});

test('monthGrid: in-month cells cover exactly the month, in order', () => {
  const weeks = monthGrid(2024, 2); // leap February
  const inMonth = weeks.flat().filter(c => c.inMonth);
  assert.equal(inMonth.length, 29);
  assert.equal(inMonth[0].iso, '2024-02-01');
  assert.equal(inMonth[28].iso, '2024-02-29');
});

test('monthGrid: Sunday start honored (Feb 2026 starts on a Sunday)', () => {
  // 2026-02-01 is a Sunday and Feb 2026 has 28 days -> exactly 4 clean weeks.
  const weeks = monthGrid(2026, 2, 0);
  assert.equal(weeks.length, 4);
  assert.equal(weeks[0][0].iso, '2026-02-01');
  assert.equal(weeks[3][6].iso, '2026-02-28');
  assert.ok(weeks.flat().every(c => c.inMonth));
});

test('monthGrid: year-boundary month leads with prior-year days', () => {
  // 2026-01-01 is a Thursday; Monday-start grid begins Dec 29, 2025.
  const weeks = monthGrid(2026, 1);
  assert.equal(weeks[0][0].iso, '2025-12-29');
  assert.equal(weeks[0][0].inMonth, false);
});

// --- month navigation ----------------------------------------------------

test('prevMonth: mid-year', () => {
  assert.deepEqual(prevMonth(2026, 7), { year: 2026, month: 6 });
});

test('prevMonth: January rolls back a year', () => {
  assert.deepEqual(prevMonth(2026, 1), { year: 2025, month: 12 });
});

test('nextMonth: mid-year', () => {
  assert.deepEqual(nextMonth(2026, 7), { year: 2026, month: 8 });
});

test('nextMonth: December rolls forward a year', () => {
  assert.deepEqual(nextMonth(2026, 12), { year: 2027, month: 1 });
});

test('monthFromIso: extracts year and month', () => {
  assert.deepEqual(monthFromIso('2026-07-15'), { year: 2026, month: 7 });
});

test('monthLabel: full month name plus year', () => {
  assert.equal(monthLabel(2026, 7), 'July 2026');
  assert.equal(monthLabel(2025, 12), 'December 2025');
});

// --- range helpers -------------------------------------------------------

test('inRange: inclusive of both endpoints', () => {
  assert.equal(inRange('2026-07-10', '2026-07-10', '2026-07-12'), true);
  assert.equal(inRange('2026-07-11', '2026-07-10', '2026-07-12'), true);
  assert.equal(inRange('2026-07-12', '2026-07-10', '2026-07-12'), true);
});

test('inRange: outside the range', () => {
  assert.equal(inRange('2026-07-09', '2026-07-10', '2026-07-12'), false);
  assert.equal(inRange('2026-07-13', '2026-07-10', '2026-07-12'), false);
});

test('inRange: false when either endpoint is missing', () => {
  assert.equal(inRange('2026-07-11', '2026-07-10', null), false);
  assert.equal(inRange('2026-07-11', null, '2026-07-12'), false);
  assert.equal(inRange('2026-07-11', null, null), false);
});

test('isRangeStart / isRangeEnd: exact match only', () => {
  assert.equal(isRangeStart('2026-07-10', '2026-07-10'), true);
  assert.equal(isRangeStart('2026-07-11', '2026-07-10'), false);
  assert.equal(isRangeStart('2026-07-10', null), false);
  assert.equal(isRangeEnd('2026-07-12', '2026-07-12'), true);
  assert.equal(isRangeEnd('2026-07-12', null), false);
});

// --- two-tap range selection ---------------------------------------------

test('nextRangeSelection: first tap sets the start', () => {
  assert.deepEqual(
    nextRangeSelection({ start: null, end: null }, '2026-07-10'),
    { start: '2026-07-10', end: null },
  );
});

test('nextRangeSelection: second tap on/after start sets the end', () => {
  assert.deepEqual(
    nextRangeSelection({ start: '2026-07-10', end: null }, '2026-07-12'),
    { start: '2026-07-10', end: '2026-07-12' },
  );
});

test('nextRangeSelection: tapping the start again makes a one-day range', () => {
  assert.deepEqual(
    nextRangeSelection({ start: '2026-07-10', end: null }, '2026-07-10'),
    { start: '2026-07-10', end: '2026-07-10' },
  );
});

test('nextRangeSelection: tap before the start restarts the range', () => {
  assert.deepEqual(
    nextRangeSelection({ start: '2026-07-10', end: null }, '2026-07-08'),
    { start: '2026-07-08', end: null },
  );
});

test('nextRangeSelection: tap with a complete range restarts', () => {
  assert.deepEqual(
    nextRangeSelection({ start: '2026-07-10', end: '2026-07-12' }, '2026-07-20'),
    { start: '2026-07-20', end: null },
  );
});

// --- today ---------------------------------------------------------------

test('todayIso: local today in YYYY-MM-DD form', () => {
  const iso = todayIso();
  assert.match(iso, /^\d{4}-\d{2}-\d{2}$/);
  const now = new Date();
  assert.equal(Number(iso.slice(0, 4)), now.getFullYear());
});
