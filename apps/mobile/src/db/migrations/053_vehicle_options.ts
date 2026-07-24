import type { SqlDb } from '../types';

// Migration 053: vehicle options wave (#152/#155/#167). Mirrors API 065. SYNCED
// columns (docs/SYNC-MIGRATION-CHECKLIST.md — pull.ts TABLE_UPSERT_SQL/rowToValues
// and queries/vehicles.ts upsertVehicleState extended in the same change).
//   debris_option 0/1, debris_level 0-100 (#152); open_checkout 0/1 (#155,
//   default 0 = owner-assigned vehicles closed until opted in); locked_by TEXT
//   UUID (#167, NULL = legacy pre-hierarchy lock).
export const migration = {
  version: 53,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE vehicles ADD COLUMN debris_option INTEGER NOT NULL DEFAULT 0`);
    db.executeSync(`ALTER TABLE vehicles ADD COLUMN debris_level INTEGER NOT NULL DEFAULT 0`);
    db.executeSync(`ALTER TABLE vehicles ADD COLUMN open_checkout INTEGER NOT NULL DEFAULT 0`);
    db.executeSync(`ALTER TABLE vehicles ADD COLUMN locked_by TEXT`);
  },
};
