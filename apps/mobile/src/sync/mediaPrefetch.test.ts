import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

// mediaPrefetch.ts / engine.ts pull in db/schema -> op-sqlite (native), which
// will not load under `node --test` — so assert against source text (repo
// pattern: pullColumns.test.ts, fullDownload.test.ts). The pure rules are
// unit-tested directly in mediaPrefetchRules.test.ts.
const DIR = dirname(new URL(import.meta.url).pathname);
const ENGINE = readFileSync(join(DIR, 'engine.ts'), 'utf8');
const PREFETCH = readFileSync(join(DIR, 'mediaPrefetch.ts'), 'utf8');
const FULL = readFileSync(join(DIR, 'fullDownload.ts'), 'utf8');

test('sync cycle fires the media prefetch after pullChanges', () => {
  const pull = ENGINE.indexOf('await pullChanges()');
  const prefetch = ENGINE.indexOf('void prefetchNewMediaThumbnails()');
  assert.ok(pull > -1, 'engine must pull');
  assert.ok(prefetch > -1, 'engine must fire the media prefetch');
  assert.ok(prefetch > pull, 'prefetch must run after the pull applied new rows');
});

test('unset watermark initializes without prefetching (no history storm)', () => {
  assert.ok(
    /if \(!watermark\) \{\s*initMediaPrefetchWatermark\(\);\s*return;/.test(PREFETCH),
    'an unset watermark must initialize-and-return, never scan/prefetch',
  );
  assert.ok(PREFETCH.includes('MAX(COALESCE(updated_at, created_at))'),
    'initialization must pin to the max existing media timestamp');
});

test('full download pins the prefetch watermark past the downloaded history', () => {
  assert.ok(FULL.includes('initMediaPrefetchWatermark()'),
    'runFullDownload must initialize the watermark so enrollment never mass-prefetches');
});
