import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqlJsDb } from './sqljsTestDb';
import { migration } from './060_dashboard_prefs';
import type { SqlDb } from '../types';

let db: SqlDb;
before(async () => {
  db = await makeSqlJsDb();
  // Pre-060 user_prefs shape (040 DDL).
  db.executeSync(`CREATE TABLE user_prefs (
    user_id TEXT PRIMARY KEY,
    theme TEXT,
    updated_at TEXT NOT NULL
  )`);
  db.executeSync(`INSERT INTO user_prefs (user_id, theme, updated_at) VALUES ('u-1', 'modern', '2026-07-01T00:00:00.000Z')`);
  migration.up(db);
});

test('060: existing rows get a NULL dashboard_prefs (nobody customized yet)', () => {
  const r = db.executeSync(`SELECT dashboard_prefs FROM user_prefs WHERE user_id = 'u-1'`).rows[0] as { dashboard_prefs: string | null };
  assert.equal(r.dashboard_prefs, null);
});

test('060: theme + updated_at untouched (column-add only, no backfill)', () => {
  const r = db.executeSync(`SELECT theme, updated_at FROM user_prefs WHERE user_id = 'u-1'`).rows[0] as { theme: string; updated_at: string };
  assert.equal(r.theme, 'modern');
  assert.equal(r.updated_at, '2026-07-01T00:00:00.000Z');
});

test('060: dashboard_prefs accepts a JSON blob write', () => {
  const json = JSON.stringify({ layout: [{ widget: 'chat', width: 'full' }], starred: ['chat'] });
  db.executeSync(`UPDATE user_prefs SET dashboard_prefs = ? WHERE user_id = 'u-1'`, [json]);
  const r = db.executeSync(`SELECT dashboard_prefs FROM user_prefs WHERE user_id = 'u-1'`).rows[0] as { dashboard_prefs: string };
  assert.deepEqual(JSON.parse(r.dashboard_prefs), { layout: [{ widget: 'chat', width: 'full' }], starred: ['chat'] });
});
