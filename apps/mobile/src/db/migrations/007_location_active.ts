import type { SqlDb } from '../types';

export const migration = {
  version: 7,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE locations ADD COLUMN active INTEGER NOT NULL DEFAULT 1`);
  },
};
