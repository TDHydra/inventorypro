import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqlJsDb } from './sqljsTestDb';
import { migration } from './054_receipt_fields';
import type { SqlDb } from '../types';

let db: SqlDb;
before(async () => {
  db = await makeSqlJsDb();
  // Pre-054 vehicle_service_records shape (042 DDL, condensed).
  db.executeSync(`CREATE TABLE vehicle_service_records (
    id TEXT PRIMARY KEY, vehicle_location_id TEXT NOT NULL, target TEXT NOT NULL,
    event_date TEXT NOT NULL, type TEXT NOT NULL, notes TEXT, odometer INTEGER,
    cost REAL, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    synced_at TEXT
  )`);
  db.executeSync(`INSERT INTO vehicle_service_records (id, vehicle_location_id, target, event_date, type, created_at, updated_at)
    VALUES ('r-1', 'v-1', 'vehicle', '2026-07-01', 'fuel_up', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`);
  migration.up(db);
});

test('054: payer and job_id exist, nullable, defaulting NULL', () => {
  const r = db.executeSync(`SELECT payer, job_id FROM vehicle_service_records WHERE id = 'r-1'`).rows[0] as { payer: string | null; job_id: string | null };
  assert.equal(r.payer, null);
  assert.equal(r.job_id, null);
});

test('054: updated_at untouched (no watermark bump)', () => {
  const r = db.executeSync(`SELECT updated_at FROM vehicle_service_records WHERE id = 'r-1'`).rows[0] as { updated_at: string };
  assert.equal(r.updated_at, '2026-07-01T00:00:00.000Z');
});
