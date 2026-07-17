import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overLimit, overRateLimit, peekOverLimit, sweepBuckets } from './rateLimit';

test('overLimit allows up to `max` within the window, then blocks', () => {
  const k = `unit-test:allow:${process.pid}:${Date.now()}`;
  assert.equal(overLimit(k, 2), false); // count 1
  assert.equal(overLimit(k, 2), false); // count 2
  assert.equal(overLimit(k, 2), true);  // count 3 > max 2 → blocked
  assert.equal(overLimit(k, 2), true);  // stays blocked in-window
});

test('overLimit buckets are per-key (distinct keys do not interfere)', () => {
  const a = `unit-test:a:${Date.now()}`;
  const b = `unit-test:b:${Date.now()}`;
  assert.equal(overLimit(a, 1), false);
  assert.equal(overLimit(a, 1), true);  // a exhausted
  assert.equal(overLimit(b, 1), false); // b independent, still allowed
});

test('overRateLimit uses the default 120/min ceiling', () => {
  const k = `unit-test:default:${Date.now()}`;
  for (let i = 0; i < 120; i++) assert.equal(overRateLimit(k), false);
  assert.equal(overRateLimit(k), true); // 121st blocked
});

test('peekOverLimit reflects the bucket state without consuming quota', () => {
  const k = `unit-test:peek:${process.pid}:${Date.now()}`;
  // No bucket yet — under, and however often we peek, still no bucket created.
  for (let i = 0; i < 50; i++) assert.equal(peekOverLimit(k, 2), false);
  assert.equal(overLimit(k, 2), false);      // count 1 — peeks above didn't count
  assert.equal(peekOverLimit(k, 2), false);  // 1 ≤ 2
  assert.equal(overLimit(k, 2), false);      // count 2
  assert.equal(peekOverLimit(k, 2), false);  // exactly at max is not over
  assert.equal(overLimit(k, 2), true);       // count 3 → over
  assert.equal(peekOverLimit(k, 2), true);   // peek sees it…
  assert.equal(peekOverLimit(k, 2), true);   // …and repeated peeks stay read-only
});

test('sweepBuckets deletes only buckets whose window has ended', () => {
  const now = Date.now();
  const map = new Map<string, { count: number; reset: number }>([
    ['unit-test:sweep:ended', { count: 40, reset: now - 1 }],   // expired → swept
    ['unit-test:sweep:active', { count: 40, reset: now + 30_000 }], // live → kept
    ['unit-test:sweep:boundary', { count: 1, reset: now }],     // now === reset → kept (not > reset)
  ]);
  const removed = sweepBuckets(now, map);
  assert.equal(removed, 1);
  assert.equal(map.has('unit-test:sweep:ended'), false);
  assert.equal(map.has('unit-test:sweep:active'), true);
  assert.equal(map.has('unit-test:sweep:boundary'), true);
});

test('sweepBuckets on an empty map is a no-op', () => {
  const map = new Map<string, { count: number; reset: number }>();
  assert.equal(sweepBuckets(Date.now(), map), 0);
  assert.equal(map.size, 0);
});
