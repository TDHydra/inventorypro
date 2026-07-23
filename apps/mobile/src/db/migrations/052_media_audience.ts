import type { SqlDb } from '../types';

// Migration 052: media pool-share audience (#87/#148). Mirrors API 064.
// SYNCED columns (docs/SYNC-MIGRATION-CHECKLIST.md): pull.ts TABLE_UPSERT_SQL
// + rowToValues extended in the same change. audience 'team'|'everyone'|'users'
// (TEXT); audience_user_ids JSON array of user UUIDs (TEXT). NULL = job/entity
// photo.
export const migration = {
  version: 52,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE media ADD COLUMN audience TEXT`);
    db.executeSync(`ALTER TABLE media ADD COLUMN audience_user_ids TEXT`);
  },
};
