import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOfflineBanner } from './offlineBannerState';

// #215: OfflineBanner show/hide + wording. NetInfo isConnected is tri-state;
// only a definite `false` may show the banner (null = unknown — NetInfo
// false-negatives on some Android networks, see sync/engine.ts).

test('hidden while connected', () => {
  assert.equal(evaluateOfflineBanner(true, 3), null);
});

test('hidden while connectivity is unknown, even with queued changes', () => {
  assert.equal(evaluateOfflineBanner(null, 3), null);
});

test('offline with nothing queued explains that writes will queue', () => {
  assert.equal(
    evaluateOfflineBanner(false, 0),
    'Working offline — changes will be saved and queued',
  );
});

test('offline with queued changes shows the count with plurals', () => {
  assert.equal(evaluateOfflineBanner(false, 1), 'Working offline — 1 change queued');
  assert.equal(evaluateOfflineBanner(false, 4), 'Working offline — 4 changes queued');
});
