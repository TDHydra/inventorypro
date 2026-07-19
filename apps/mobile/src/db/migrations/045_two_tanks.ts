import type { SqlDb } from '../types';

// Migration 045: two-tank vehicle state (#122 Phase A1). Mirrors API 057.
// water_state stays (deprecated — no reader after Phase A2). Backfill: only
// 'full' needs mapping; 'empty_clean' is exactly the new columns' defaults.
export const migration = {
  version: 45,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE vehicles ADD COLUMN water_tank TEXT NOT NULL DEFAULT 'empty'`);
    db.executeSync(`ALTER TABLE vehicles ADD COLUMN waste_tank TEXT NOT NULL DEFAULT 'clean'`);
    db.executeSync(`UPDATE vehicles SET water_tank = 'full' WHERE water_state = 'full'`);
  },
};
