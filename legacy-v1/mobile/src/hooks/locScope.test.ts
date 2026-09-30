import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionBySourceStock } from './locScope';

const ITEMS = [
  { id: 'a', name: 'Air mover' },
  { id: 'b', name: 'Bleach' },
  { id: 'c', name: 'Cleaner' },
  { id: 'd', name: 'Dehumidifier bags' },
];

test('#140: items without stock at the source are NOT dropped', () => {
  const qty = new Map([['b', 3]]);
  const { atSource, elsewhere } = partitionBySourceStock(ITEMS, qty);
  assert.equal(atSource.length + elsewhere.length, ITEMS.length);
  assert.deepEqual(elsewhere.map(i => i.id), ['a', 'c', 'd']);
});

test('#140: empty source (no stock rows) surfaces the whole catalog', () => {
  const { atSource, elsewhere } = partitionBySourceStock(ITEMS, new Map());
  assert.equal(atSource.length, 0);
  assert.deepEqual(elsewhere.map(i => i.id), ['a', 'b', 'c', 'd']);
});

test('at-source items come first and both groups keep input order', () => {
  const qty = new Map([['d', 1], ['b', 2]]);
  const { atSource, elsewhere } = partitionBySourceStock(ITEMS, qty);
  assert.deepEqual(atSource.map(i => i.id), ['b', 'd']);
  assert.deepEqual(elsewhere.map(i => i.id), ['a', 'c']);
});

test('zero/negative quantities count as not-at-source', () => {
  const qty = new Map([['a', 0], ['b', -2], ['c', 5]]);
  const { atSource, elsewhere } = partitionBySourceStock(ITEMS, qty);
  assert.deepEqual(atSource.map(i => i.id), ['c']);
  assert.deepEqual(elsewhere.map(i => i.id), ['a', 'b', 'd']);
});
