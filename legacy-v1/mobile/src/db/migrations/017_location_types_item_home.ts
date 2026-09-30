import type { SqlDb } from '../types';

// Migration 017: location types + item home location.
//   locations.type            — location_type taxonomy label (Shop, Vehicle, …)
//   inventory_items.home_location_id — where an item belongs (often a shelf)
export const migration = {
  version: 17,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE locations ADD COLUMN type TEXT`);
    db.executeSync(`ALTER TABLE inventory_items ADD COLUMN home_location_id TEXT`);
  },
};
