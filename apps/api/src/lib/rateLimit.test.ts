import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overLimit, overRateLimit } from './rateLimit';

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
