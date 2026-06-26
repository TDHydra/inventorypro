import { DB } from '@op-engineering/op-sqlite';

export const migration = {
  version: 2,
  up: (db: DB): void => {
    // Extra inventory item fields (additive — no data loss).
    db.executeSync(`ALTER TABLE inventory_items ADD COLUMN sku TEXT`);
    db.executeSync(`ALTER TABLE inventory_items ADD COLUMN supplier TEXT`);
    db.executeSync(`ALTER TABLE inventory_items ADD COLUMN model TEXT`);
    db.executeSync(`ALTER TABLE inventory_items ADD COLUMN reorder_to REAL`);
  },
};
