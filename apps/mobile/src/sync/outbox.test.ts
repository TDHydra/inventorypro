import { createRequire } from 'node:module';
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// isMediaUploadPending (#180): outbox.ts can't load under `node --test` as-is —
// db/schema imports the native op-sqlite binding, and utils/uuid imports
// react-native-get-random-values. Same Module._load intercept pattern as
// vehiclesLock.test.ts / uploadCore.test.ts — db/schema becomes a real sql.js
// database (locationsShelf.testdb.ts).
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module = requireCjs('node:module') as any;
const testDb = requireCjs('../db/queries/locationsShelf.testdb') as typeof import('../db/queries/locationsShelf.testdb');

const origLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'react-native-get-random-values') return {};
  if (request === 'react-native' || request === 'expo' || request === 'expo-modules-core') {
    return new Proxy({ __esModule: true }, { get: (_t, p) => (p === '__esModule' ? true : () => {}) });
  }
  let resolved = '';
  try { resolved = Module._resolveFilename(request, parent); } catch { /* not ours — fall through */ }
  if (resolved.endsWith('/src/db/schema.ts')) return testDb;
  return origLoad.call(this, request, parent, isMain);
};

let outbox: typeof import('./outbox');
const db = testDb;

before(async () => {
  await testDb.initTestDb(); // creates outbox (+ locations/taxonomy_types/etc.)
  outbox = requireCjs('./outbox') as typeof import('./outbox');
});

beforeEach(() => {
  db.getDb().executeSync(`DELETE FROM outbox`);
});

test('isMediaUploadPending: false when no outbox entry references the id', () => {
  assert.equal(outbox.isMediaUploadPending('media-1'), false);
});

test('isMediaUploadPending: true for an undelivered media INSERT payload', () => {
  outbox.appendOutbox('INSERT', 'media', { id: 'media-1', entity_type: 'job', entity_id: 'job-1' });
  assert.equal(outbox.isMediaUploadPending('media-1'), true);
});

test('isMediaUploadPending: false once the entry is marked synced', () => {
  outbox.appendOutbox('INSERT', 'media', { id: 'media-1', entity_type: 'job', entity_id: 'job-1' });
  const row = db.rowsAs<{ id: string }>(
    db.getDb().executeSync(`SELECT id FROM outbox WHERE table_name = 'media'`).rows
  )[0];
  outbox.markOutboxSynced([row.id]);
  assert.equal(outbox.isMediaUploadPending('media-1'), false);
});

test('isMediaUploadPending: unaffected by a pending row for a DIFFERENT media id', () => {
  outbox.appendOutbox('INSERT', 'media', { id: 'media-1', entity_type: 'job', entity_id: 'job-1' });
  assert.equal(outbox.isMediaUploadPending('media-2'), false);
});

test('isMediaUploadPending: scoped to table_name — a matching id under another table does not count', () => {
  outbox.appendOutbox('INSERT', 'repairs', { id: 'media-1', entity_type: 'job', entity_id: 'job-1' });
  assert.equal(outbox.isMediaUploadPending('media-1'), false);
});
