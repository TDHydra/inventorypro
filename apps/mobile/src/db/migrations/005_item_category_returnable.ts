import { DB } from '@op-engineering/op-sqlite';

export const migration = {
  version: 5,
  up: (db: DB): void => {
    db.executeSync(`ALTER TABLE inventory_items ADD COLUMN category TEXT`);
    db.executeSync(`ALTER TABLE inventory_items ADD COLUMN returnable INTEGER NOT NULL DEFAULT 0`);
    db.executeSync(`UPDATE inventory_items SET returnable = 1 WHERE kind = 'equipment'`);
  },
};
