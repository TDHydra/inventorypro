import type { SqlDb } from '../types';

// Migration 038: equipment type taxonomy (#28). Mirrors API migration 048.
// Adds the label column (`type`, display cache) + the durable taxonomy FK
// (`type_id`, soft reference — no constraint, same rationale as 029) to
// inventory_items so equipment can be classified (Generator, Air Mover, …).
// No backfill: the column is brand new, no legacy labels exist to resolve.
export const migration = {
  version: 38,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE inventory_items ADD COLUMN type TEXT`);
    db.executeSync(`ALTER TABLE inventory_items ADD COLUMN type_id TEXT`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS inventory_items_type_id_idx ON inventory_items(type_id)`);
  },
};
