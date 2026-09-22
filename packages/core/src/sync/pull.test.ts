// pullChanges end-to-end against sql.js: manifest-derived upserts applied,
// watermark advanced, changed-table set returned, FK enforcement restored.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initTestDb, configureTestCore, stubFetch } from '../test/helpers';
import type { SqlDb } from '../db/provider';
import { pullChanges } from './pull';

let db: SqlDb;

before(async () => {
  configureTestCore();
  db = await initTestDb(['app_settings', 'teams']);
});

beforeEach(() => {
  db.executeSync('DELETE FROM app_settings');
  db.executeSync('DELETE FROM teams');
});

test('applies pulled rows via the manifest contract and reports the changed set', async () => {
  const calls = stubFetch(() => ({
    body: {
      teams: { rows: [{ id: 't1', name: 'Crew A', type: 'field', updated_at: '2026-01-01T00:00:00Z', type_id: null }] },
    },
  }));

  const changed = await pullChanges();
  assert.deepEqual([...changed], ['teams']);

  const row = db.executeSync(`SELECT * FROM teams WHERE id = 't1'`).rows[0];
  assert.equal(row.name, 'Crew A');
  assert.equal(row.type, 'field');

  // First pull uses the epoch watermark, then advances it.
  assert.match(calls[0].url, /\/sync\/pull\?since=1970-01-01/);
  const wm = db.executeSync(`SELECT value FROM app_settings WHERE key = 'last_pulled_at'`).rows[0];
  assert.ok(wm, 'watermark stored');

  // FK enforcement restored after the batch.
  assert.equal(db.executeSync('PRAGMA foreign_keys').rows[0].foreign_keys, 1);
});

test('empty diff: no bump set, but watermark still advances', async () => {
  stubFetch(() => ({ body: {} }));
  const changed = await pullChanges();
  assert.equal(changed.size, 0);
  const wm = db.executeSync(`SELECT value FROM app_settings WHERE key = 'last_pulled_at'`).rows[0];
  assert.ok(wm);
});

test('unknown table in the response is ignored, not fatal', async () => {
  stubFetch(() => ({ body: { not_a_table: { rows: [{ id: 'x' }] } } }));
  const changed = await pullChanges();
  assert.equal(changed.size, 0);
});

test('non-OK response throws (cycle retries later)', async () => {
  stubFetch(() => ({ status: 500, body: 'nope' }));
  await assert.rejects(pullChanges(), /Pull failed: 500/);
});

test('signed out (null jwt): no fetch, empty set', async () => {
  configureTestCore({
    auth: { getValidJwt: async () => null, revalidateSession: async () => undefined, getSavedUserId: async () => null },
  });
  const calls = stubFetch(() => ({ body: {} }));
  const changed = await pullChanges();
  assert.equal(changed.size, 0);
  assert.equal(calls.length, 0);
  configureTestCore();
});
