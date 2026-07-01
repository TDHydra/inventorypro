import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk, buildMessages, deadTokensFromReceipts } from './push';

test('chunk splits into batches of size', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});
test('buildMessages maps tokens to expo messages with payload', () => {
  const msgs = buildMessages(['ExpoTok1', 'ExpoTok2'], { title: 'Hi', body: 'B', data: { screen: 's' } });
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[0], { to: 'ExpoTok1', title: 'Hi', body: 'B', data: { screen: 's' } });
});
test('deadTokensFromReceipts returns DeviceNotRegistered tokens', () => {
  const receipts = { r1: { status: 'ok' }, r2: { status: 'error', details: { error: 'DeviceNotRegistered' } } };
  const dead = deadTokensFromReceipts(receipts, { r1: 'tokA', r2: 'tokB' });
  assert.deepEqual(dead, ['tokB']);
});
