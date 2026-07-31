import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqlJsDb } from './sqljsTestDb';
import { migration } from './056_repair_steps';
import type { SqlDb } from '../types';

let db: SqlDb;
before(async () => {
  db = await makeSqlJsDb();
  migration.up(db);
});

test('056: repair_steps row round-trips action/result/attribution', () => {
  db.executeSync(
    `INSERT INTO repair_steps (id, repair_id, action, result, created_by, created_at, updated_at, synced_at)
     VALUES ('s-1', 'r-1', 'Checked the fuse', 'Fuse was blown, replaced it', 'u-1', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', NULL)`,
  );
  const r = db.executeSync(`SELECT * FROM repair_steps WHERE id = 's-1'`).rows[0] as {
    repair_id: string; action: string; result: string; created_by: string; synced_at: string | null;
  };
  assert.equal(r.repair_id, 'r-1');
  assert.equal(r.action, 'Checked the fuse');
  assert.equal(r.result, 'Fuse was blown, replaced it');
  assert.equal(r.created_by, 'u-1');
  assert.equal(r.synced_at, null);
});

test('056: result is nullable (a step can be logged before its outcome is known)', () => {
  db.executeSync(
    `INSERT INTO repair_steps (id, repair_id, action, created_by, created_at, updated_at)
     VALUES ('s-2', 'r-1', 'Ordered replacement part', 'u-1', '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z')`,
  );
  const r = db.executeSync(`SELECT result FROM repair_steps WHERE id = 's-2'`).rows[0] as { result: string | null };
  assert.equal(r.result, null);
});

test('056: action is required (NOT NULL)', () => {
  assert.throws(() => {
    db.executeSync(
      `INSERT INTO repair_steps (id, repair_id, created_by, created_at, updated_at)
       VALUES ('s-3', 'r-1', 'u-1', '2026-07-03T00:00:00.000Z', '2026-07-03T00:00:00.000Z')`,
    );
  });
});

test('056: repair_id index exists', () => {
  const rows = db.executeSync(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'repair_steps'`,
  ).rows as Array<{ name: string }>;
  assert.ok(rows.some(r => r.name === 'repair_steps_repair_id_idx'));
});
