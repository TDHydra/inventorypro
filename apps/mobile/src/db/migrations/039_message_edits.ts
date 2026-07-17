import type { SqlDb } from '../types';

// Migration 039: message edit/delete markers (#29 Step C). Mirrors API
// migration 049. edited_at marks a sender-edited message; deleted_at marks a
// soft-deleted one (the server blanks the body — deleted messages never retain
// content). Both nullable TEXT timestamps, SQLite-style (see 034).
export const migration = {
  version: 39,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE messages ADD COLUMN edited_at TEXT`);
    db.executeSync(`ALTER TABLE messages ADD COLUMN deleted_at TEXT`);
  },
};
