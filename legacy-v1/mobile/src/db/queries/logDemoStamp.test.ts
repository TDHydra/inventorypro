import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

// log.ts cannot be imported here (db/schema -> op-sqlite is native), so assert
// against source — same approach as pullColumns.test.ts / fullDownload.test.ts.
//
// Why this test exists: demo/test sessions DO write activity_log rows (the
// Activity Logs screen is part of what a test account exists to demonstrate),
// but every such row must be stamped `demo: true` so it can never be mistaken
// for real activity — including in the outbox payload, which is what would
// reach a server if the sandbox gate ever regressed.
const SRC = readFileSync(join(dirname(new URL(import.meta.url).pathname), 'log.ts'), 'utf8');

test('appendLog stamps demo:true on rows written during a sandbox session', () => {
  assert.ok(SRC.includes('isSandboxActive()'), 'appendLog must know whether it is in a demo session');
  assert.match(SRC, /demo: true/, 'sandbox rows must carry a demo marker');
});

test('the demo stamp is applied to BOTH the local row and the outbox payload', () => {
  const localInsert = /entryMetadata, entry\.device_id, created_at,/.test(SRC);
  const outboxPayload = /metadata: entryMetadata,/.test(SRC);
  assert.ok(localInsert, 'the local activity_log INSERT must bind the stamped metadata');
  assert.ok(outboxPayload, 'the outbox payload must carry the stamped metadata, not the raw entry');
  assert.ok(!/metadata: entry\.metadata,/.test(SRC),
    'no path may write the unstamped metadata for a sandbox row');
});
