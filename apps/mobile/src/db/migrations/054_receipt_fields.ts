import type { SqlDb } from '../types';

// Migration 054: gas-receipt fields (#168). Mirrors API 066. SYNCED columns
// (docs/SYNC-MIGRATION-CHECKLIST.md — pull.ts + createServiceRecord extended in
// the same change). payer from app_config gas_receipt_payers; job_id soft FK.
export const migration = {
  version: 54,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE vehicle_service_records ADD COLUMN payer TEXT`);
    db.executeSync(`ALTER TABLE vehicle_service_records ADD COLUMN job_id TEXT`);
  },
};
