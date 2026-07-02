import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactProps, excessToEvict, BUFFER_CAP } from './redact';

test('keeps allowlisted keys, drops content/PII keys', () => {
  const out = redactProps({ itemId: 'i', durationMs: 5, pin: '1234', note: 'secret', name2: 'x' });
  assert.deepEqual(Object.keys(out).sort(), ['durationMs', 'itemId']);
});

test('excessToEvict — ring buffer only evicts what is over cap', () => {
  assert.equal(excessToEvict(0, 100), 0);
  assert.equal(excessToEvict(100, 100), 0);   // exactly at cap → nothing
  assert.equal(excessToEvict(101, 100), 1);   // one over → evict one
  assert.equal(excessToEvict(150, 100), 50);
  // default cap
  assert.equal(excessToEvict(BUFFER_CAP), 0);
  assert.equal(excessToEvict(BUFFER_CAP + 7), 7);
});
