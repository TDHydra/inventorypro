import { DB } from '@op-engineering/op-sqlite';

export const migration = {
  version: 7,
  up: (db: DB): void => {
    db.executeSync(`ALTER TABLE locations ADD COLUMN active INTEGER NOT NULL DEFAULT 1`);
  },
};
