import type { SqlDb } from '../types';

// Migration 041: subteams (#123) — 2-person crews inside a team (lead + helper,
// e.g. Frank Turner + Matt = "TV/FT"). Mirrors API migration 053. Soft FKs
// (no REFERENCES on cross-synced ids — sync-order-safe, maintenance_events
// precedent). team_members gains subteam_id/subteam_role ('lead'/'helper').
export const migration = {
  version: 41,
  up: (db: SqlDb): void => {
    db.executeSync(`CREATE TABLE IF NOT EXISTS subteams (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT
    )`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS subteams_team_idx ON subteams(team_id)`);
    db.executeSync(`ALTER TABLE team_members ADD COLUMN subteam_id TEXT`);
    db.executeSync(`ALTER TABLE team_members ADD COLUMN subteam_role TEXT`);
  },
};
