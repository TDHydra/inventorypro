import type { SqlDb } from '../types';

// Migration 035: jobs gain an optional owning team. Mirrors API migration 043.
// NULL means "org-wide" — visible to everyone — which is what every pre-existing
// job is, so nothing disappears from a device when the scoped pull goes live.
//
// Also arms the one-time team purge. Before API 043, `teams` and `team_members`
// were pulled unscoped, so this device may hold rows for teams the user does not
// belong to. Incremental pull is upsert-only and never deletes, so the server
// scoping alone would leave those rows here forever. The sync engine reads this
// flag, deletes both tables, and re-downloads them scoped.
//
// The purge deliberately does NOT touch the outbox: resetLocalDb() would drop
// un-pushed offline edits.
export const migration = {
  version: 35,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE jobs ADD COLUMN team_id TEXT`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS jobs_team_idx ON jobs (team_id)`);
    db.executeSync(
      `INSERT OR REPLACE INTO app_settings (key, value) VALUES ('teams_purge_pending', '1')`,
    );
  },
};
