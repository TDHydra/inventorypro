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

// markOutboxDenied / getDeniedOutbox / discardDeniedEntry / getDeniedCount (#202):
// a permanently-denied entry (an authorization rejection) is kept — not
// deleted like the old dropOutboxEntry path — but must disappear from every
// "still active" query (getPendingOutbox, getPendingCount, getOutboxCounts,
// getFailedOutbox, isMediaUploadPending) since it will never be delivered.

test('markOutboxDenied: row moves out of getPendingOutbox and into getDeniedOutbox', () => {
  outbox.appendOutbox('INSERT', 'schedule_assignments', { id: 'sa-1' });
  const row = db.rowsAs<{ id: string }>(
    db.getDb().executeSync(`SELECT id FROM outbox WHERE table_name = 'schedule_assignments'`).rows
  )[0];

  outbox.markOutboxDenied(row.id, "Your account can't edit schedules — this change wasn't saved.");

  assert.deepEqual(outbox.getPendingOutbox(), []);
  assert.equal(outbox.getPendingCount(), 0);

  const [denied] = outbox.getDeniedOutbox();
  assert.equal(denied.id, row.id);
  assert.equal(denied.last_error, "Your account can't edit schedules — this change wasn't saved.");
  assert.equal(outbox.getDeniedCount(), 1);
});

test('markOutboxDenied: excluded from getOutboxCounts (neither active nor failed)', () => {
  outbox.appendOutbox('INSERT', 'jobs', { id: 'job-1' });
  const row = db.rowsAs<{ id: string }>(
    db.getDb().executeSync(`SELECT id FROM outbox WHERE table_name = 'jobs'`).rows
  )[0];

  outbox.markOutboxDenied(row.id, 'denied');

  assert.deepEqual(outbox.getOutboxCounts(), { active: 0, failed: 0 });
  assert.deepEqual(outbox.getFailedOutbox(), []);
});

test('markOutboxDenied: excluded from isMediaUploadPending — a denied media write will never land', () => {
  outbox.appendOutbox('INSERT', 'media', { id: 'media-1', entity_type: 'job', entity_id: 'job-1' });
  const row = db.rowsAs<{ id: string }>(
    db.getDb().executeSync(`SELECT id FROM outbox WHERE table_name = 'media'`).rows
  )[0];

  outbox.markOutboxDenied(row.id, 'denied');

  assert.equal(outbox.isMediaUploadPending('media-1'), false);
});

test('discardDeniedEntry: removes the row entirely', () => {
  outbox.appendOutbox('INSERT', 'jobs', { id: 'job-2' });
  const row = db.rowsAs<{ id: string }>(
    db.getDb().executeSync(`SELECT id FROM outbox WHERE table_name = 'jobs'`).rows
  )[0];
  outbox.markOutboxDenied(row.id, 'denied');

  outbox.discardDeniedEntry(row.id);

  assert.equal(outbox.getDeniedCount(), 0);
  const remaining = db.getDb().executeSync(`SELECT * FROM outbox WHERE id = ?`, [row.id]).rows;
  assert.equal(remaining.length, 0);
});

test('discardDeniedEntry: cannot be used to drop a non-denied (still-active) entry', () => {
  outbox.appendOutbox('INSERT', 'jobs', { id: 'job-3' });
  const row = db.rowsAs<{ id: string }>(
    db.getDb().executeSync(`SELECT id FROM outbox WHERE table_name = 'jobs'`).rows
  )[0];

  outbox.discardDeniedEntry(row.id); // not denied — should be a no-op

  const remaining = db.getDb().executeSync(`SELECT * FROM outbox WHERE id = ?`, [row.id]).rows;
  assert.equal(remaining.length, 1);
});
