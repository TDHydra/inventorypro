import { DB } from '@op-engineering/op-sqlite';

// Migration 013: P6 hardening — job external reference number.
// reference_number is a manual/external reference (insurance claim / customer PO),
// distinct from the internal jobs.job_number.
// NOTE: processed_outbox is server-only; not created on mobile.
export const migration = {
  version: 13,
  up: (db: DB): void => {
    db.executeSync(`ALTER TABLE jobs ADD COLUMN reference_number TEXT`);
  },
};
