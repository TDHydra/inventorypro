import type { SqlDb } from '../types';

// Migration 043: locker access grants (#126). Mirrors API migration 055.
// One row = "this user may take stock from this Locker-typed location". The
// server enforces this hard (negative-delta ADJUST guard in routes/sync.ts);
// locally it drives which lockers appear in fast-checkout (access kernel).
// Composite PK = the sync conflict target.
export const migration = {
  version: 43,
  up: (db: SqlDb): void => {
    db.executeSync(`CREATE TABLE IF NOT EXISTS locker_access (
      location_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      granted_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT,
      PRIMARY KEY (location_id, user_id)
    )`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS locker_access_user_idx ON locker_access(user_id)`);
  },
};
