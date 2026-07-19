import type { SqlDb } from '../types';

// Migration 046: per-action unit access (#122 Phase A1). Mirrors API 058.
// Copies locker_access grants as view+add+remove+move (synced_at carried over —
// the server ran the same copy, so nothing needs re-pushing). locker_access
// stays; readers move to unit_access in code.
export const migration = {
  version: 46,
  up: (db: SqlDb): void => {
    db.executeSync(`CREATE TABLE IF NOT EXISTS unit_access (
      location_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      can_view INTEGER NOT NULL DEFAULT 1,
      can_add INTEGER NOT NULL DEFAULT 0,
      can_remove INTEGER NOT NULL DEFAULT 0,
      can_move INTEGER NOT NULL DEFAULT 0,
      can_edit_details INTEGER NOT NULL DEFAULT 0,
      can_grant INTEGER NOT NULL DEFAULT 0,
      granted_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT,
      PRIMARY KEY (location_id, user_id)
    )`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS unit_access_user_idx ON unit_access(user_id)`);
    db.executeSync(
      `INSERT OR IGNORE INTO unit_access
         (location_id, user_id, can_view, can_add, can_remove, can_move, can_edit_details, can_grant, granted_by, created_at, updated_at, synced_at)
       SELECT location_id, user_id, 1, 1, 1, 1, 0, 0, granted_by, created_at, updated_at, synced_at
         FROM locker_access`,
    );
  },
};
