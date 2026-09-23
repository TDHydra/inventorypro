import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isQuietHoursNow, utcMinutesNow } from './quietHours';

test('isQuietHoursNow: disabled when either bound is null', () => {
  assert.equal(isQuietHoursNow(null, 420, 100), false);
  assert.equal(isQuietHoursNow(1320, null, 100), false);
  assert.equal(isQuietHoursNow(null, null, 100), false);
});

test('isQuietHoursNow: zero-width window is disabled, not "always on"', () => {
  assert.equal(isQuietHoursNow(600, 600, 0), false);
  assert.equal(isQuietHoursNow(600, 600, 600), false);
  assert.equal(isQuietHoursNow(600, 600, 1439), false);
});

// Non-wrapping window: 09:00 -> 17:00 UTC (540 -> 1020).
test('isQuietHoursNow: non-wrapping window, table-driven', () => {
  const cases: [number, boolean][] = [
    [0, false],
    [539, false],
    [540, true], // start inclusive
    [800, true],
    [1019, true],
    [1020, false], // end exclusive
    [1439, false],
  ];
  for (const [now, expected] of cases) {
    assert.equal(isQuietHoursNow(540, 1020, now), expected, `now=${now}`);
  }
});

// Wrapping window: 22:00 -> 07:00 UTC (1320 -> 420).
test('isQuietHoursNow: midnight-wrapping window, table-driven', () => {
  const cases: [number, boolean][] = [
    [0, true],
    [419, true],
    [420, false], // end exclusive
    [421, false],
    [1000, false],
    [1319, false],
    [1320, true], // start inclusive
    [1439, true],
  ];
  for (const [now, expected] of cases) {
    assert.equal(isQuietHoursNow(1320, 420, now), expected, `now=${now}`);
  }
});

test('utcMinutesNow reads UTC hours/minutes from a given Date', () => {
  assert.equal(utcMinutesNow(new Date('2026-08-03T00:00:00Z')), 0);
  assert.equal(utcMinutesNow(new Date('2026-08-03T13:37:00Z')), 13 * 60 + 37);
  assert.equal(utcMinutesNow(new Date('2026-08-03T23:59:00Z')), 23 * 60 + 59);
});
