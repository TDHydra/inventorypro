import type { SqlDb } from '../types';

// Migration 040: per-user synced preferences (#112). Mirrors API migration 052.
// One row per user; theme is the selected theme id (TEXT — never an enum, see
// the app_config precedent and the prod enum-remap incident). Server enforces
// self-write via attribution (user_id forced to the caller on push).
export const migration = {
  version: 40,
  up: (db: SqlDb): void => {
    db.executeSync(`CREATE TABLE IF NOT EXISTS user_prefs (
      user_id TEXT PRIMARY KEY,
      theme TEXT,
      updated_at TEXT NOT NULL
    )`);
  },
};
