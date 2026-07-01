import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeEvent, sanitizeLabel } from './telemetry';

const CTRL0 = String.fromCharCode(0);   // NUL
const CTRL31 = String.fromCharCode(31);  // unit separator

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
test('sanitizeLabel strips control chars + collapses whitespace + caps length', () => {
  assert.equal(sanitizeLabel('a' + CTRL0 + 'b' + CTRL31 + 'c'), 'abc');
  assert.equal(sanitizeLabel('foo   bar\t baz'), 'foo bar baz');
  assert.equal(sanitizeLabel('y'.repeat(500)).length, 120);
});
test('sanitizeEvent cleans name + screen (not just props)', () => {
  const e = sanitizeEvent({ type: 'screen', name: '  home' + CTRL0 + '  ', screen: 'a' + CTRL31 + 'b' });
  assert.equal(e!.name, 'home');
  assert.equal(e!.screen, 'ab');
});
