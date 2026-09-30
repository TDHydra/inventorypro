import type { SqlDb } from '../types';

// Migration 027: equipment lifecycle — maintenance_events (service/repair log per
// unit) + depreciation/service-schedule fields on equipment_units. Mirrors API
// migration 033. One ALTER per column (migration 022 pattern). No FK on
// maintenance_events.unit_id — matches repair_parts' sync-order-safe design.
export const migration = {
  version: 27,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE equipment_units ADD COLUMN purchase_price REAL`);
    db.executeSync(`ALTER TABLE equipment_units ADD COLUMN acquired_at TEXT`);
    db.executeSync(`ALTER TABLE equipment_units ADD COLUMN useful_life_months INTEGER`);
    db.executeSync(`ALTER TABLE equipment_units ADD COLUMN salvage_value REAL`);
    db.executeSync(`ALTER TABLE equipment_units ADD COLUMN depreciation_method TEXT`);
    db.executeSync(`ALTER TABLE equipment_units ADD COLUMN next_service_at TEXT`);
    db.executeSync(`ALTER TABLE equipment_units ADD COLUMN service_interval_months INTEGER`);
    db.executeSync(`CREATE TABLE IF NOT EXISTS maintenance_events (
      id TEXT PRIMARY KEY,
      unit_id TEXT NOT NULL,
      event_date TEXT NOT NULL,
      type TEXT NOT NULL,
      notes TEXT,
      cost REAL,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT
    )`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS maintenance_events_unit_idx ON maintenance_events(unit_id)`);
  },
};
