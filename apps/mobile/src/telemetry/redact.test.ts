import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactProps } from './redact';

test('keeps allowlisted keys, drops content/PII keys', () => {
  const out = redactProps({ itemId: 'i', durationMs: 5, pin: '1234', note: 'secret', name2: 'x' });
  assert.deepEqual(Object.keys(out).sort(), ['durationMs', 'itemId']);
});
