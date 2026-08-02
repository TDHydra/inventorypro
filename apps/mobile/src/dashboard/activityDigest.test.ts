import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tallyActions } from './activityDigest';

const rows = (...actions: string[]) => actions.map(a => ({ action: a }));

test('tallies action counts sorted by count descending', () => {
  assert.deepEqual(
    tallyActions(rows('checkout', 'checkin', 'checkout', 'checkout', 'checkin', 'add_stock')),
    [
      { action: 'checkout', count: 3 },
      { action: 'checkin', count: 2 },
      { action: 'add_stock', count: 1 },
    ],
  );
});

test('ties break alphabetically for a stable render order', () => {
  assert.deepEqual(
    tallyActions(rows('b_action', 'a_action')),
    [{ action: 'a_action', count: 1 }, { action: 'b_action', count: 1 }],
  );
});

test('caps at top N', () => {
  const out = tallyActions(rows('a', 'a', 'b', 'b', 'c', 'd', 'e'), 3);
  assert.deepEqual(out.map(r => r.action), ['a', 'b', 'c']);
});

test('empty input tallies to an empty list', () => {
  assert.deepEqual(tallyActions([]), []);
});
