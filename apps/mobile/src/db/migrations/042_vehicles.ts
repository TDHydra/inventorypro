import type { SqlDb } from '../types';

// Migration 042: vehicles (#125) — real state for Vehicle-typed locations.
// Mirrors API migration 054. Three tables, all soft-FK:
//   vehicles                 1:1 extension of a Vehicle-type location (PK = the
//                            location id): truck mount, water state
//                            ('full'/'empty_clean'), model label + taxonomy
//                            soft-FK, notes.
//   vehicle_service_records  service log (target 'vehicle'/'truck_mount'/'both');
//                            cost is financial — the server omits it for callers
//                            without view_financial_data, so it is nullable.
//   vehicle_checkouts        individual-holder sessions; job_id nullable and
//                            editable later; open session = checked_in_at IS NULL.
//
// #81 seed: vehicle_model taxonomy with the SAME fixed UUIDs as API migration
// 054 so the picker works on-device before the API deploys and both sides
// converge on sync (INSERT OR IGNORE + fixed literal updated_at — migration 030
// pattern).
const MODEL_ROWS: [id: string, label: string, icon: string, sort_order: number][] = [
  ['c4a81000-0000-4000-8000-000000000001', 'Chevy Cargo Van', '🚐', 0],
  ['c4a81000-0000-4000-8000-000000000002', 'Chevy Box Truck', '🚚', 1],
  ['c4a81000-0000-4000-8000-000000000003', 'Ford Transit 350', '🚐', 2],
  ['c4a81000-0000-4000-8000-000000000004', 'Ford Transit City Van', '🚐', 3],
  ['c4a81000-0000-4000-8000-000000000005', 'Ford Maverick', '🛻', 4],
];

export const migration = {
  version: 42,
  up: (db: SqlDb): void => {
    db.executeSync(`CREATE TABLE IF NOT EXISTS vehicles (
      location_id TEXT PRIMARY KEY,
      truck_mount INTEGER NOT NULL DEFAULT 0,
      water_state TEXT,
      model TEXT,
      model_id TEXT,
      notes TEXT,
      updated_at TEXT NOT NULL,
      synced_at TEXT
    )`);
    db.executeSync(`CREATE TABLE IF NOT EXISTS vehicle_service_records (
      id TEXT PRIMARY KEY,
      vehicle_location_id TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT 'vehicle',
      event_date TEXT NOT NULL,
      type TEXT NOT NULL,
      notes TEXT,
      odometer INTEGER,
      cost REAL,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT
    )`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS vehicle_service_records_vehicle_idx ON vehicle_service_records(vehicle_location_id)`);
    db.executeSync(`CREATE TABLE IF NOT EXISTS vehicle_checkouts (
      id TEXT PRIMARY KEY,
      vehicle_location_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      job_id TEXT,
      checked_out_at TEXT NOT NULL,
      checked_in_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT
    )`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS vehicle_checkouts_vehicle_idx ON vehicle_checkouts(vehicle_location_id)`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS vehicle_checkouts_user_idx ON vehicle_checkouts(user_id)`);
    for (const [id, label, icon, sort_order] of MODEL_ROWS) {
      db.executeSync(
        `INSERT OR IGNORE INTO taxonomy_types (id, category, label, icon, sort_order, active, updated_at) VALUES (?, 'vehicle_model', ?, ?, ?, 1, '2026-07-18T00:00:00.000Z')`,
        [id, label, icon, sort_order],
      );
    }
  },
};
