import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextLockMs, sweepAttempts, WINDOW_MS, isRefreshToken } from '../routes/auth';

test('exponential backoff grows with fail count and caps', () => {
  assert.equal(nextLockMs(2), 0);            // below threshold, no lock
  assert.ok(nextLockMs(3) > 0);
  assert.ok(nextLockMs(8) > nextLockMs(3));
  assert.ok(nextLockMs(50) <= 60 * 60_000);  // capped at 1h
});

test('sweepAttempts deletes expired unlocked entries only', () => {
  const now = Date.now();
  const map = new Map<string, { count: number; first: number; lockedUntil: number }>([
    // window elapsed, not locked → swept
    ['unit-test:expired', { count: 2, first: now - WINDOW_MS - 1, lockedUntil: 0 }],
    // window elapsed but lockout still active → kept (never drop a live lock)
    ['unit-test:locked', { count: 9, first: now - WINDOW_MS - 1, lockedUntil: now + 60_000 }],
    // window still open → kept
    ['unit-test:fresh', { count: 1, first: now - 1_000, lockedUntil: 0 }],
    // lock expired AND window elapsed → swept
    ['unit-test:lock-expired', { count: 5, first: now - WINDOW_MS - 1, lockedUntil: now - 1 }],
  ]);
  const removed = sweepAttempts(now, map);
  assert.equal(removed, 2);
  assert.equal(map.has('unit-test:expired'), false);
  assert.equal(map.has('unit-test:lock-expired'), false);
  assert.equal(map.has('unit-test:locked'), true);
  assert.equal(map.has('unit-test:fresh'), true);
});

test('sweepAttempts on an empty map is a no-op', () => {
  const map = new Map<string, { count: number; first: number; lockedUntil: number }>();
  assert.equal(sweepAttempts(Date.now(), map), 0);
  assert.equal(map.size, 0);
});

test('isRefreshToken flags refresh payloads and passes legacy access payloads', () => {
  assert.equal(isRefreshToken({ sub: 'u1', type: 'refresh' }), true);
  assert.equal(isRefreshToken({ sub: 'u1', name: 'n', role: 'admin' }), false); // legacy, no type
  assert.equal(isRefreshToken({ sub: 'u1', type: 'access' }), false);
  assert.equal(isRefreshToken(null), false);
  assert.equal(isRefreshToken('refresh'), false);
});
