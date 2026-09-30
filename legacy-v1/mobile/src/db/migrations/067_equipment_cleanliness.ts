import type { SqlDb } from '../types';

// Migration 067: equipment/item cleanliness ("filth") state (#248). Mirrors
// API migration 081. Additive-only (new columns, safe defaults) — no
// migration test needed, per mig-055 precedent.
//
// equipment_units.cleanliness TEXT NOT NULL DEFAULT 'clean' — TEXT not enum
// (house rule: no Postgres ENUM on synced columns), free-form so a future
// third state doesn't need another migration. equipment_units.
// jobs_since_clean INTEGER NOT NULL DEFAULT 0 — incremented client-side at
// job check-in (see src/equipment/cleanliness.ts's applyCheckIn); no server
// trigger, offline-first.
//
// inventory_items.needs_cleaning INTEGER NOT NULL DEFAULT 0 — mirrors the
// `returnable` precedent (migration 005): bulk items don't have per-unit
// tracking, so this is a flat opt-in flag. inventory_items.clean_after_jobs
// INTEGER NULL — the auto-dirty cadence (NULL/0 = off, mirrors
// min_qty_alert's 0→NULL write-boundary convention).
//
// SYNCED columns (docs/SYNC-MIGRATION-CHECKLIST.md): pull.ts's
// TABLE_UPSERT_SQL + rowToValues extended for BOTH tables in the same
// change. equipment_units projection: syncPolicy's EQUIPMENT_UNITS_BASE
// (not SENSITIVE — these aren't financial). inventory_items falls through
// to syncPolicy's '*' — no projection change needed.
export const migration = {
  version: 67,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE equipment_units ADD COLUMN cleanliness TEXT NOT NULL DEFAULT 'clean'`);
    db.executeSync(`ALTER TABLE equipment_units ADD COLUMN jobs_since_clean INTEGER NOT NULL DEFAULT 0`);
    db.executeSync(`ALTER TABLE inventory_items ADD COLUMN needs_cleaning INTEGER NOT NULL DEFAULT 0`);
    db.executeSync(`ALTER TABLE inventory_items ADD COLUMN clean_after_jobs INTEGER`);
  },
};
