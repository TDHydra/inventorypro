import { DB } from '@op-engineering/op-sqlite';

export const migration = {
  version: 11,
  up: (db: DB): void => {
    db.executeSync(
      `CREATE TABLE IF NOT EXISTS taxonomy_types (
         id         TEXT PRIMARY KEY,
         category   TEXT NOT NULL,
         label      TEXT NOT NULL,
         icon       TEXT,
         sort_order INTEGER NOT NULL DEFAULT 0,
         active     INTEGER NOT NULL DEFAULT 1,
         updated_at TEXT NOT NULL
       )`
    );
    db.executeSync(`ALTER TABLE jobs ADD COLUMN type TEXT`);
  },
};
