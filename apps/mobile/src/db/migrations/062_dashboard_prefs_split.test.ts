import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqlJsDb } from './sqljsTestDb';
import { migration } from './062_dashboard_prefs_split';
import type { SqlDb } from '../types';

let db: SqlDb;
before(async () => {
  db = await makeSqlJsDb();
  // Pre-062 user_prefs shape (040 DDL + 060's dashboard_prefs blob column).
  db.executeSync(`CREATE TABLE user_prefs (
    user_id TEXT PRIMARY KEY,
    theme TEXT,
    dashboard_prefs TEXT,
    updated_at TEXT NOT NULL
  )`);
  db.executeSync(
    `INSERT INTO user_prefs (user_id, theme, dashboard_prefs, updated_at) VALUES
     ('u-both', 'modern', ?, '2026-07-01T00:00:00.000Z'),
     ('u-layout-only', NULL, ?, '2026-07-01T00:00:00.000Z'),
     ('u-starred-only', NULL, ?, '2026-07-01T00:00:00.000Z'),
     ('u-none', 'classic', NULL, '2026-07-01T00:00:00.000Z'),
     ('u-invalid-json', NULL, 'not-json', '2026-07-01T00:00:00.000Z')`,
    [
      JSON.stringify({ layout: [{ widget: 'chat', width: 'full' }], starred: ['chat', 'low-stock'] }),
      JSON.stringify({ layout: [{ widget: 'low-stock', width: 'half' }] }),
      JSON.stringify({ starred: ['on-call'] }),
    ]
  );
  migration.up(db);
});

function row(userId: string) {
  return db.executeSync(
    `SELECT dashboard_layout, starred_widgets, dashboard_prefs, theme FROM user_prefs WHERE user_id = ?`,
    [userId]
  ).rows[0] as { dashboard_layout: string | null; starred_widgets: string | null; dashboard_prefs: string | null; theme: string | null };
}

test('062: a row with both sub-fields backfills both new columns', () => {
  const r = row('u-both');
  assert.deepEqual(JSON.parse(r.dashboard_layout!), [{ widget: 'chat', width: 'full' }]);
  assert.deepEqual(JSON.parse(r.starred_widgets!), ['chat', 'low-stock']);
  // Old blob is left in place (dead), not dropped.
  assert.ok(r.dashboard_prefs);
  assert.equal(r.theme, 'modern');
});

test('062: a row with only layout backfills dashboard_layout, leaves starred_widgets NULL', () => {
  const r = row('u-layout-only');
  assert.deepEqual(JSON.parse(r.dashboard_layout!), [{ widget: 'low-stock', width: 'half' }]);
  assert.equal(r.starred_widgets, null);
});

test('062: a row with only starred backfills starred_widgets, leaves dashboard_layout NULL', () => {
  const r = row('u-starred-only');
  assert.equal(r.dashboard_layout, null);
  assert.deepEqual(JSON.parse(r.starred_widgets!), ['on-call']);
});

test('062: a row that never customized gets NULL for both new columns', () => {
  const r = row('u-none');
  assert.equal(r.dashboard_layout, null);
  assert.equal(r.starred_widgets, null);
  assert.equal(r.theme, 'classic');
});

test('062: invalid JSON in the legacy blob is skipped, not thrown', () => {
  const r = row('u-invalid-json');
  assert.equal(r.dashboard_layout, null);
  assert.equal(r.starred_widgets, null);
});

test('062: new columns accept a direct write (column now exists and is writable)', () => {
  db.executeSync(`UPDATE user_prefs SET dashboard_layout = ? WHERE user_id = 'u-none'`,
    [JSON.stringify([{ widget: 'checkin', width: 'full' }])]);
  const r = row('u-none');
  assert.deepEqual(JSON.parse(r.dashboard_layout!), [{ widget: 'checkin', width: 'full' }]);
});
