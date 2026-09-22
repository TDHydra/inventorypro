import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushRecent, parseRecent } from './recentPicks';

test('pushRecent puts the new id first', () => {
  assert.deepEqual(pushRecent(['a', 'b'], 'c'), ['c', 'a', 'b']);
});

test('pushRecent dedupes a re-picked id to the front', () => {
  assert.deepEqual(pushRecent(['a', 'b', 'c'], 'b'), ['b', 'a', 'c']);
});

test('pushRecent caps the list at 3 by default', () => {
  assert.deepEqual(pushRecent(['a', 'b', 'c'], 'd'), ['d', 'a', 'b']);
});

test('parseRecent returns [] for null, junk, and non-string entries', () => {
  assert.deepEqual(parseRecent(null), []);
  assert.deepEqual(parseRecent('not json'), []);
  assert.deepEqual(parseRecent('{"a":1}'), []);
  assert.deepEqual(parseRecent('["a", 2, null, "b"]'), ['a', 'b']);
});
