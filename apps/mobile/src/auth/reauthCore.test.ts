import { test } from 'node:test';
import assert from 'node:assert';
import { isReauthDue } from './reauthCore';

const T0 = '2026-08-03T12:00:00.000Z';

test('isReauthDue: disabled (0 minutes) is never due, however stale the stamp', () => {
  assert.equal(isReauthDue('2026-08-01T00:00:00.000Z', 0, T0), false);
  assert.equal(isReauthDue(null, 0, T0), false);
});

test('isReauthDue: never-stamped (null) fails open — not due', () => {
  assert.equal(isReauthDue(null, 15, T0), false);
});

test('isReauthDue: well within the window is not due', () => {
  // 5 minutes elapsed, 15-minute policy.
  assert.equal(isReauthDue('2026-08-03T11:55:00.000Z', 15, T0), false);
});

test('isReauthDue: exactly at the boundary is due (>=)', () => {
  // Exactly 15 minutes elapsed, 15-minute policy.
  assert.equal(isReauthDue('2026-08-03T11:45:00.000Z', 15, T0), true);
});

test('isReauthDue: past the window is due', () => {
  // 4 hours elapsed (e.g. backgrounded in a pocket), 30-minute policy —
  // this is the exact "background dwell" case idleTimerCore's AppState reset
  // would have silently missed.
  assert.equal(isReauthDue('2026-08-03T08:00:00.000Z', 30, T0), true);
});

test('isReauthDue: malformed timestamp fails open', () => {
  assert.equal(isReauthDue('not-a-date', 15, T0), false);
});

test('isReauthDue: a stamp in the future (clock skew) fails open, not instant-due', () => {
  assert.equal(isReauthDue('2026-08-03T13:00:00.000Z', 15, T0), false);
});

test('isReauthDue: negative minutes treated as disabled', () => {
  assert.equal(isReauthDue('2026-08-01T00:00:00.000Z', -5, T0), false);
});
