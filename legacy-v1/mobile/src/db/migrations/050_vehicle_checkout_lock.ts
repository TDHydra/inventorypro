import type { SqlDb } from '../types';

// Migration 050: vehicles.checkout_locked (#157). Mirrors API 062. SYNCED
// column (see docs/SYNC-MIGRATION-CHECKLIST.md — pull.ts TABLE_UPSERT_SQL/
// rowToValues and queries/vehicles.ts upsertVehicleState/ensureVehicleRow were
// extended in the same change). 0/1: when 1, only the vehicle's owner (or
// tier-3+ org authority) may open a checkout session — the vehicle stays
// visible everywhere, checkOutVehicle/takeOverVehicle hard-guard the rest.
export const migration = {
  version: 50,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE vehicles ADD COLUMN checkout_locked INTEGER NOT NULL DEFAULT 0`);
  },
};
