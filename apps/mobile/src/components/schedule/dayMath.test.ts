import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDaysIso,
  localTodayIso,
  DAY_START_MIN,
  DAY_END_MIN,
  formatDayLabel,
  formatMinute,
  chipSpan,
  snapRange,
} from './dayMath';

// ------------------------------------------------------------- formatDayLabel

test('formatDayLabel: plain mid-month date', () => {
  assert.equal(formatDayLabel('2026-08-04'), 'Tue, Aug 4');
});

test('formatDayLabel: cross-month boundary', () => {
  assert.equal(formatDayLabel('2026-07-31'), 'Fri, Jul 31');
  assert.equal(formatDayLabel('2026-08-01'), 'Sat, Aug 1');
});

test('formatDayLabel: cross-year boundary', () => {
  assert.equal(formatDayLabel('2025-12-31'), 'Wed, Dec 31');
  assert.equal(formatDayLabel('2026-01-01'), 'Thu, Jan 1');
});

test('formatDayLabel: leap-year Feb 29 and the day after', () => {
  assert.equal(formatDayLabel('2024-02-29'), 'Thu, Feb 29');
  assert.equal(formatDayLabel('2024-03-01'), 'Fri, Mar 1');
});

// -------------------------------------------------------------- formatMinute

test('formatMinute: on-the-hour AM/PM', () => {
  assert.equal(formatMinute(480), '8:00 AM');
  assert.equal(formatMinute(540), '9:00 AM');
  assert.equal(formatMinute(1020), '5:00 PM');
});

test('formatMinute: noon and midnight edges', () => {
  assert.equal(formatMinute(0), '12:00 AM');
  assert.equal(formatMinute(720), '12:00 PM');
});

test('formatMinute: non-hour minute is zero-padded', () => {
  assert.equal(formatMinute(555), '9:15 AM');
  assert.equal(formatMinute(1305), '9:45 PM');
});

// ------------------------------------------------------------------ chipSpan

test('chipSpan: fully in-window', () => {
  const span = chipSpan(540, 600, 100); // 9:00-10:00, colWidth=100 => 100px/hour
  assert.equal(span.left, (540 - DAY_START_MIN) / 60 * 100);
  assert.equal(span.width, 60 / 60 * 100);
  assert.equal(span.clampedLeft, false);
  assert.equal(span.clampedRight, false);
});

test('chipSpan: clamped on the left (starts before the window)', () => {
  const span = chipSpan(420, 540, 100); // 7:00-9:00, window starts 8:00
  assert.equal(span.left, 0);
  assert.equal(span.width, (540 - DAY_START_MIN) / 60 * 100);
  assert.equal(span.clampedLeft, true);
  assert.equal(span.clampedRight, false);
});

test('chipSpan: clamped on the right (ends after the window)', () => {
  const span = chipSpan(960, 1080, 100); // 16:00-18:00, window ends 17:00
  assert.equal(span.left, (960 - DAY_START_MIN) / 60 * 100);
  assert.equal(span.width, (DAY_END_MIN - 960) / 60 * 100);
  assert.equal(span.clampedLeft, false);
  assert.equal(span.clampedRight, true);
});

test('chipSpan: fully outside the window on either side collapses to a zero-width clamp', () => {
  const before = chipSpan(60, 300, 100); // 1:00-5:00, entirely before 8:00
  assert.equal(before.left, 0);
  assert.equal(before.width, 0);
  assert.equal(before.clampedLeft, true);
  assert.equal(before.clampedRight, false);

  const after = chipSpan(1080, 1200, 100); // 18:00-20:00, entirely after 17:00
  assert.equal(after.width, 0);
  assert.equal(after.clampedLeft, false);
  assert.equal(after.clampedRight, true);
});

// ----------------------------------------------------------------- snapRange

test('snapRange: rounds both edges to the nearest 30 minutes', () => {
  assert.deepEqual(snapRange(547, 613), [540, 600]);
});

test('snapRange: clamps to [0, 1440]', () => {
  assert.deepEqual(snapRange(-10, 20), [0, 30]);
  const [s, e] = snapRange(1430, 1450);
  assert.ok(s >= 0 && e <= 1440);
  assert.ok(e > s);
});

test('snapRange: orders — pushes end after a start that lands on/after it', () => {
  const [s, e] = snapRange(600, 550);
  assert.ok(e > s, 'end must always be after start');
  assert.equal(s, 600);
  assert.equal(e, 630);
});

// -------------------------------------------------------------- re-exports

test('re-export smoke: addDaysIso and localTodayIso are the real weekMath implementations', () => {
  assert.equal(typeof addDaysIso, 'function');
  assert.equal(addDaysIso('2026-08-04', 3), '2026-08-07');
  assert.equal(typeof localTodayIso, 'function');
  assert.match(localTodayIso(new Date(2026, 0, 15)), /^2026-01-15$/);
});
