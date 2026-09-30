import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqlJsDb } from './sqljsTestDb';
import { migration } from './057_repair_parts_step_id';
import type { SqlDb } from '../types';

let db: SqlDb;
before(async () => {
  db = await makeSqlJsDb();
  // Pre-057 repair_parts shape (023 DDL).
  db.executeSync(`CREATE TABLE repair_parts (
    id TEXT PRIMARY KEY, repair_id TEXT NOT NULL, item_id TEXT NOT NULL,
    qty REAL NOT NULL, unit TEXT NOT NULL, created_by TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT
  )`);
  db.executeSync(
    `INSERT INTO repair_parts (id, repair_id, item_id, qty, unit, created_at, updated_at)
     VALUES ('p-1', 'r-1', 'i-1', 2, 'each', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
  );
  migration.up(db);
});

test('057: existing rows get a NULL step_id', () => {
  const r = db.executeSync(`SELECT step_id FROM repair_parts WHERE id = 'p-1'`).rows[0] as { step_id: string | null };
  assert.equal(r.step_id, null);
});

test('057: updated_at untouched (no watermark bump — NULL default converges)', () => {
  const r = db.executeSync(`SELECT updated_at FROM repair_parts WHERE id = 'p-1'`).rows[0] as { updated_at: string };
  assert.equal(r.updated_at, '2026-07-01T00:00:00.000Z');
});

test('057: a new row can carry a step_id', () => {
  db.executeSync(
    `INSERT INTO repair_parts (id, repair_id, item_id, qty, unit, step_id, created_at, updated_at)
     VALUES ('p-2', 'r-1', 'i-2', 1, 'each', 's-1', '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z')`,
  );
  const r = db.executeSync(`SELECT step_id FROM repair_parts WHERE id = 'p-2'`).rows[0] as { step_id: string | null };
  assert.equal(r.step_id, 's-1');
});
