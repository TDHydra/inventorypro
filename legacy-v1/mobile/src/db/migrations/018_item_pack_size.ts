import type { SqlDb } from '../types';

// Migration 018: item pack size (entry helper). How many BASE units come in one
// pack (e.g. 4 gal/pack). NULL = no pack concept. Stock stays in the base unit.
export const migration = {
  version: 18,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE inventory_items ADD COLUMN pack_size INTEGER`);
  },
};
