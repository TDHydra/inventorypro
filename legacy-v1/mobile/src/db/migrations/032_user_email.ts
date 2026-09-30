import type { SqlDb } from '../types';

// Migration 032: users.email — optional contact address. Mirrors API migration
// 038. SYNCED column (see docs/SYNC-MIGRATION-CHECKLIST.md — pull.ts users
// TABLE_UPSERT_SQL/rowToValues and the server USERS_COLS were updated in the same
// change). Nullable TEXT; no format enforcement at the DB layer.
export const migration = {
  version: 32,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE users ADD COLUMN email TEXT`);
  },
};
