import type { SqlDb } from '../types';

// Migration 026: drop the deprecated teams.manager_id column. Mirrors API
// migration 027. Since 015 managers are flagged per-member (team_members.is_manager)
// and manager_id has been unread/unwritten since; the server dropped it, so the
// local column would only break sync column/placeholder parity. SQLite >= 3.35
// (shipped by both op-sqlite and sql.js) supports ALTER TABLE ... DROP COLUMN.
export const migration = {
  version: 26,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE teams DROP COLUMN manager_id`);
  },
};
