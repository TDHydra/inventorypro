-- Migration 015: P5 5b — multi-manager teams.
-- team_members gains is_manager (members flagged as managers) + a mutable updated_at
-- so promote/demote propagates via incremental pull (joined_at is append-only).
-- The single teams.manager_id is migrated into a flagged member row; manager_id is
-- kept (deprecated/unread) — no destructive drop.
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS is_manager BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Backfill updated_at from joined_at for existing rows.
UPDATE team_members SET updated_at = joined_at;

-- Migrate the single teams.manager_id into a flagged member row per team.
INSERT INTO team_members (team_id, user_id, is_manager, joined_at, updated_at)
SELECT id, manager_id, TRUE, NOW(), NOW()
FROM teams
WHERE manager_id IS NOT NULL
ON CONFLICT (team_id, user_id) DO UPDATE SET is_manager = TRUE, updated_at = NOW();
