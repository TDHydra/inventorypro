import type { SqlDb } from '../types';

// Migration 063: chat @mentions (#241). Mirrors API migration 077, and the
// media.audience_user_ids precedent (052/064): mentioned_user_ids is a JSON
// array of user UUIDs (TEXT), NULL when the message has no @mentions.
// SYNCED column (docs/SYNC-MIGRATION-CHECKLIST.md): pull.ts TABLE_UPSERT_SQL
// + rowToValues extended in the same change, plus syncPolicy MESSAGES_COLS.
export const migration = {
  version: 63,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE messages ADD COLUMN mentioned_user_ids TEXT`);
  },
};
