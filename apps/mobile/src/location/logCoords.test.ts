import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLogCoords } from './logCoords';

// resolveLogCoords is the guarantee behind #33: every log write auto-stamps the
// cached foreground fix, but an explicit coord always wins and a missing fix
// degrades to null (never blocks the write).

const FIX = { latitude: 40.1, longitude: -74.2, accuracy: 12 };

test('caller-supplied coords win over the cache', () => {
  const out = resolveLogCoords({ latitude: 1, longitude: 2, location_accuracy: 3 }, FIX);
  assert.deepEqual(out, { latitude: 1, longitude: 2, location_accuracy: 3 });
});

test('falls back to the cached fix when the caller omits coords', () => {
  const out = resolveLogCoords({}, FIX);
  assert.deepEqual(out, { latitude: 40.1, longitude: -74.2, location_accuracy: 12 });
});

test('a null cache degrades to null coords (never throws, never blocks)', () => {
  const out = resolveLogCoords({}, null);
  assert.deepEqual(out, { latitude: null, longitude: null, location_accuracy: null });
});

test('a null cache with explicit coords still keeps the explicit coords', () => {
  const out = resolveLogCoords({ latitude: 5, longitude: 6, location_accuracy: null }, null);
  assert.deepEqual(out, { latitude: 5, longitude: 6, location_accuracy: null });
});

test('accuracy alone falls back independently of lat/long', () => {
  // Explicit lat/long but no accuracy → accuracy comes from the cache.
  const out = resolveLogCoords({ latitude: 5, longitude: 6 }, FIX);
  assert.deepEqual(out, { latitude: 5, longitude: 6, location_accuracy: 12 });
});

test('a cache with null accuracy yields null accuracy, not a throw', () => {
  const out = resolveLogCoords({}, { latitude: 1, longitude: 2, accuracy: null });
  assert.deepEqual(out, { latitude: 1, longitude: 2, location_accuracy: null });
});
