import { test } from 'node:test';
import assert from 'node:assert';
import { pickPrefetchUrl, nextWatermark, SELECT_NEW_MEDIA_SQL } from './mediaPrefetchRules';

test('pickPrefetchUrl prefers the thumbnail when present', () => {
  assert.equal(
    pickPrefetchUrl({ media_type: 'image', url: 'u', thumbnail_url: 't' }), 't');
  assert.equal(
    pickPrefetchUrl({ media_type: 'video', url: 'u', thumbnail_url: 't' }), 't');
});

test('pickPrefetchUrl falls back to url only for images', () => {
  assert.equal(
    pickPrefetchUrl({ media_type: 'image', url: 'u', thumbnail_url: null }), 'u');
  // never fetch a video binary
  assert.equal(
    pickPrefetchUrl({ media_type: 'video', url: 'u', thumbnail_url: null }), null);
});

test('nextWatermark takes the batch max across updated_at/created_at', () => {
  const rows = [
    { updated_at: '2026-07-10T00:00:00Z', created_at: '2026-07-01T00:00:00Z' },
    { updated_at: null, created_at: '2026-07-12T00:00:00Z' },
    { updated_at: '2026-07-11T00:00:00Z', created_at: '2026-07-02T00:00:00Z' },
  ];
  assert.equal(nextWatermark(rows, '2026-07-05T00:00:00Z'), '2026-07-12T00:00:00Z');
});

test('nextWatermark returns current for an empty batch or older rows', () => {
  assert.equal(nextWatermark([], '2026-07-05T00:00:00Z'), '2026-07-05T00:00:00Z');
  assert.equal(
    nextWatermark([{ updated_at: '2026-07-01T00:00:00Z', created_at: '2026-06-01T00:00:00Z' }], '2026-07-05T00:00:00Z'),
    '2026-07-05T00:00:00Z');
});

test('batch scan is bounded and oldest-first (watermark monotonicity contract)', () => {
  assert.ok(/ORDER BY COALESCE\(updated_at, created_at\) ASC/.test(SELECT_NEW_MEDIA_SQL));
  assert.ok(/LIMIT \?/.test(SELECT_NEW_MEDIA_SQL));
});
