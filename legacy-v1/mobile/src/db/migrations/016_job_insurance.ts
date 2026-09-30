import type { SqlDb } from '../types';

// Migration 016: P5 5c — job insurance carrier.
// insurance_carrier is the insurance company/carrier name, distinct from
// reference_number which holds the insurance claim #/customer PO.
export const migration = {
  version: 16,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE jobs ADD COLUMN insurance_carrier TEXT`);
  },
};
