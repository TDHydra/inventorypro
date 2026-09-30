import type { SqlDb } from '../types';

// Migration 055: vehicle fuel gauge (#174). Mirrors API 067. SYNCED column
// (docs/SYNC-MIGRATION-CHECKLIST.md — pull.ts TABLE_UPSERT_SQL/rowToValues and
// queries/vehicles.ts upsertVehicleState extended in the same change).
//   fuel_level: 0-100 drag-to-fill level, same idiom as debris_level (053).
export const migration = {
  version: 55,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE vehicles ADD COLUMN fuel_level INTEGER NOT NULL DEFAULT 0`);
  },
};
