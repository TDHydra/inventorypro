import type { SqlDb } from '../types';

export const migration = {
  version: 10,
  up: (db: SqlDb): void => {
    db.executeSync(
      `CREATE TABLE IF NOT EXISTS app_config (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL,
         updated_at TEXT
       )`
    );
  },
};
