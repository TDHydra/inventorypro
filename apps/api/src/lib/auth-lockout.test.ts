import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextLockMs } from '../routes/auth';

test('exponential backoff grows with fail count and caps', () => {
  assert.equal(nextLockMs(2), 0);            // below threshold, no lock
  assert.ok(nextLockMs(3) > 0);
  assert.ok(nextLockMs(8) > nextLockMs(3));
  assert.ok(nextLockMs(50) <= 60 * 60_000);  // capped at 1h
});
