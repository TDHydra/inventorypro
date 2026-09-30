import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqlJsDb } from './sqljsTestDb';
import { migration } from './046_unit_access';
import type { SqlDb } from '../types';

let db: SqlDb;
before(async () => {
  db = await makeSqlJsDb();
  // Pre-046 locker_access shape (migration 043 DDL verbatim).
  db.executeSync(`CREATE TABLE locker_access (
    location_id TEXT NOT NULL, user_id TEXT NOT NULL, granted_by TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT,
    PRIMARY KEY (location_id, user_id)
  )`);
  db.executeSync(`INSERT INTO locker_access VALUES ('loc-1', 'user-a', 'owner-1', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`);
  migration.up(db);
});

test('046: legacy grant copied as view+add+remove+move, not edit/grant', () => {
  const r = db.executeSync(`SELECT * FROM unit_access WHERE location_id = 'loc-1' AND user_id = 'user-a'`).rows[0] as Record<string, unknown>;
  assert.ok(r, 'copied row exists');
  assert.equal(r.can_view, 1);
  assert.equal(r.can_add, 1);
  assert.equal(r.can_remove, 1);
  assert.equal(r.can_move, 1);
  assert.equal(r.can_edit_details, 0);
  assert.equal(r.can_grant, 0);
  assert.equal(r.granted_by, 'owner-1');
});

test('046: locker_access survives untouched (deprecated, not dropped)', () => {
  assert.equal(db.executeSync(`SELECT COUNT(*) AS n FROM locker_access`).rows[0]!.n, 1);
});
