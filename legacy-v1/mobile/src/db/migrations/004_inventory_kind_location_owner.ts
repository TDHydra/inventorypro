import type { SqlDb } from '../types';

export const migration = {
  version: 4,
  up: (db: SqlDb): void => {
    // Distinguish durable equipment from consumable products. Existing rows are
    // consumables → 'product' is the correct default.
    db.executeSync(`ALTER TABLE inventory_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'product'`);
    // A location may belong to a person (PM locker/vehicle). Nullable, general.
    db.executeSync(`ALTER TABLE locations ADD COLUMN owner_user_id TEXT`);
  },
};
