import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqlJsDb } from './sqljsTestDb';
import { migration } from './045_two_tanks';
import type { SqlDb } from '../types';

let db: SqlDb;
before(async () => {
  db = await makeSqlJsDb();
  // Pre-045 vehicles shape (migration 042 DDL verbatim).
  db.executeSync(`CREATE TABLE vehicles (
    location_id TEXT PRIMARY KEY, truck_mount INTEGER NOT NULL DEFAULT 0,
    water_state TEXT, model TEXT, model_id TEXT, notes TEXT,
    updated_at TEXT NOT NULL, synced_at TEXT
  )`);
  const seed = (id: string, ws: string | null) =>
    db.executeSync(`INSERT INTO vehicles (location_id, water_state, updated_at) VALUES (?, ?, '2026-07-01T00:00:00.000Z')`, [id, ws]);
  seed('v-full', 'full'); seed('v-empty', 'empty_clean'); seed('v-null', null);
  migration.up(db);
});

test('045: water_state full → water_tank full', () => {
  const r = db.executeSync(`SELECT water_tank, waste_tank FROM vehicles WHERE location_id = 'v-full'`).rows[0] as { water_tank: string; waste_tank: string };
  assert.equal(r.water_tank, 'full');
  assert.equal(r.waste_tank, 'clean');
});

test('045: empty_clean and NULL both land on the defaults (empty/clean)', () => {
  for (const id of ['v-empty', 'v-null']) {
    const r = db.executeSync(`SELECT water_tank, waste_tank FROM vehicles WHERE location_id = ?`, [id]).rows[0] as { water_tank: string; waste_tank: string };
    assert.equal(r.water_tank, 'empty');
    assert.equal(r.waste_tank, 'clean');
  }
});

test('045: water_state column survives (old writers keep working)', () => {
  const r = db.executeSync(`SELECT water_state FROM vehicles WHERE location_id = 'v-full'`).rows[0] as { water_state: string };
  assert.equal(r.water_state, 'full');
});
