import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeEvent } from './telemetry';

test('drops event with unknown type', () => {
  assert.equal(sanitizeEvent({ type: 'evil', name: 'x' }), null);
});
test('keeps only allowlisted prop keys, drops PII-ish keys', () => {
  const e = sanitizeEvent({ type: 'action', name: 'tap', screen: 'inventory',
    props: { itemId: 'i1', durationMs: 12, pin: '1234', customerName: 'Bob' } });
  assert.deepEqual(Object.keys(e!.props).sort(), ['durationMs', 'itemId']);
});
test('truncates over-long name', () => {
  const e = sanitizeEvent({ type: 'screen', name: 'x'.repeat(500) });
  assert.ok(e!.name.length <= 200);
});
