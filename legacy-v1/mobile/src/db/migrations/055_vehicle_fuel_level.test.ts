import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqlJsDb } from './sqljsTestDb';
import { migration } from './055_vehicle_fuel_level';
import type { SqlDb } from '../types';

let db: SqlDb;
before(async () => {
  db = await makeSqlJsDb();
  // Pre-055 vehicles shape (042 + 045 + 050 + 053 DDL, condensed).
  db.executeSync(`CREATE TABLE vehicles (
    location_id TEXT PRIMARY KEY, truck_mount INTEGER NOT NULL DEFAULT 0,
    water_state TEXT, model TEXT, model_id TEXT, notes TEXT,
    updated_at TEXT NOT NULL, synced_at TEXT,
    water_tank TEXT NOT NULL DEFAULT 'empty', waste_tank TEXT NOT NULL DEFAULT 'clean',
    checkout_locked INTEGER NOT NULL DEFAULT 0,
    debris_option INTEGER NOT NULL DEFAULT 0, debris_level INTEGER NOT NULL DEFAULT 0,
    open_checkout INTEGER NOT NULL DEFAULT 0, locked_by TEXT
  )`);
  db.executeSync(`INSERT INTO vehicles (location_id, updated_at) VALUES ('v-1', '2026-07-01T00:00:00.000Z')`);
  migration.up(db);
});

test('055: existing rows get the fuel_level default', () => {
  const r = db.executeSync(`SELECT fuel_level FROM vehicles WHERE location_id = 'v-1'`).rows[0] as { fuel_level: number };
  assert.equal(r.fuel_level, 0);
});

test('055: updated_at untouched (no watermark bump — default converges)', () => {
  const r = db.executeSync(`SELECT updated_at FROM vehicles WHERE location_id = 'v-1'`).rows[0] as { updated_at: string };
  assert.equal(r.updated_at, '2026-07-01T00:00:00.000Z');
});
