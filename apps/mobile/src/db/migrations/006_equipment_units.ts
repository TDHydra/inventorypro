import type { SqlDb } from '../types';

export const migration = {
  version: 6,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE inventory_items ADD COLUMN unit_tracked INTEGER NOT NULL DEFAULT 0`);
    db.executeSync(`ALTER TABLE inventory_items ADD COLUMN tag_prefix TEXT`);
    db.executeSync(`
      CREATE TABLE IF NOT EXISTS equipment_units (
        id                  TEXT PRIMARY KEY,
        item_id             TEXT NOT NULL,
        asset_tag           TEXT NOT NULL,
        serial_number       TEXT,
        status              TEXT NOT NULL DEFAULT 'available',
        current_location_id TEXT,
        current_job_id      TEXT,
        notes               TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        synced_at           TEXT
      )
    `);
    db.executeSync(`CREATE UNIQUE INDEX IF NOT EXISTS equipment_units_tag_idx ON equipment_units(asset_tag)`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS equipment_units_item_idx ON equipment_units(item_id)`);
  },
};
