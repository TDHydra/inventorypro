import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStarKey, parseStarKey } from './starKeys';

test('makeStarKey: plain widget key without a source', () => {
  assert.equal(makeStarKey('scan'), 'scan');
});

test('makeStarKey: composite widget:source key', () => {
  assert.equal(makeStarKey('work-list', 'my-jobs'), 'work-list:my-jobs');
});

test('parseStarKey: plain widget key round-trips', () => {
  assert.deepEqual(parseStarKey('scan'), { widget: 'scan' });
});

test('parseStarKey: composite key round-trips', () => {
  assert.deepEqual(parseStarKey('work-list:my-jobs'), { widget: 'work-list', source: 'my-jobs' });
});

test('parseStarKey: unknown widget (plain or composite) returns null', () => {
  assert.equal(parseStarKey('no-such-widget'), null);
  assert.equal(parseStarKey('no-such-widget:my-jobs'), null);
});

test('parseStarKey: non-string junk returns null', () => {
  assert.equal(parseStarKey(42 as unknown as string), null);
  assert.equal(parseStarKey('' as string), null);
});
