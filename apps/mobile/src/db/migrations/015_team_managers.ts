import { DB } from '@op-engineering/op-sqlite';

// Migration 015: P5 5b — multi-manager teams.
// team_members gains is_manager (members flagged as managers) + a mutable updated_at
// so promote/demote propagates via incremental pull (joined_at is append-only).
// The single teams.manager_id is migrated into a flagged member row; manager_id is
// kept (deprecated/unread) — no destructive drop.
export const migration = {
  version: 15,
  up: (db: DB): void => {
    db.executeSync(`ALTER TABLE team_members ADD COLUMN is_manager INTEGER NOT NULL DEFAULT 0`);
    db.executeSync(`ALTER TABLE team_members ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`);
    // Backfill updated_at from joined_at for existing rows.
    db.executeSync(`UPDATE team_members SET updated_at = joined_at`);
    // Migrate the single teams.manager_id into a flagged member row per team.
    const now = new Date().toISOString();
    db.executeSync(
      `INSERT INTO team_members (team_id, user_id, is_manager, joined_at, updated_at)
       SELECT id, manager_id, 1, ?, ?
       FROM teams
       WHERE manager_id IS NOT NULL
       ON CONFLICT (team_id, user_id) DO UPDATE SET is_manager = 1, updated_at = excluded.updated_at`,
      [now, now]
    );
  },
};
