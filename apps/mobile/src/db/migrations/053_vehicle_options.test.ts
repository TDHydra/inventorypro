import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqlJsDb } from './sqljsTestDb';
import { migration } from './053_vehicle_options';
import type { SqlDb } from '../types';

let db: SqlDb;
before(async () => {
  db = await makeSqlJsDb();
  // Pre-053 vehicles shape (042 + 045 + 050 DDL, condensed).
  db.executeSync(`CREATE TABLE vehicles (
    location_id TEXT PRIMARY KEY, truck_mount INTEGER NOT NULL DEFAULT 0,
    water_state TEXT, model TEXT, model_id TEXT, notes TEXT,
    updated_at TEXT NOT NULL, synced_at TEXT,
    water_tank TEXT NOT NULL DEFAULT 'empty', waste_tank TEXT NOT NULL DEFAULT 'clean',
    checkout_locked INTEGER NOT NULL DEFAULT 0
  )`);
  db.executeSync(`INSERT INTO vehicles (location_id, updated_at) VALUES ('v-1', '2026-07-01T00:00:00.000Z')`);
  migration.up(db);
});

test('053: existing rows get the four option defaults', () => {
  const r = db.executeSync(`SELECT debris_option, debris_level, open_checkout, locked_by FROM vehicles WHERE location_id = 'v-1'`).rows[0] as { debris_option: number; debris_level: number; open_checkout: number; locked_by: string | null };
  assert.equal(r.debris_option, 0);
  assert.equal(r.debris_level, 0);
  assert.equal(r.open_checkout, 0);
  assert.equal(r.locked_by, null);
});

test('053: updated_at untouched (no watermark bump — defaults converge)', () => {
  const r = db.executeSync(`SELECT updated_at FROM vehicles WHERE location_id = 'v-1'`).rows[0] as { updated_at: string };
  assert.equal(r.updated_at, '2026-07-01T00:00:00.000Z');
});
