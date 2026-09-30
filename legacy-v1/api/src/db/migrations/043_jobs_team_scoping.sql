-- Team scoping (see docs/TEAMS-SCOPING-PLAN.md).
--
-- Until now `teams` and `team_members` were pulled unscoped, so every enrolled
-- device held every team's roster AND its team_permission_overrides. This
-- migration adds the column and indexes the scoped pull needs; the predicate
-- itself lives in routes/sync.ts (teamScopeSql).

-- Jobs gain an optional owning team. NULL means "org-wide": visible to everyone.
-- Every existing job is NULL, so the scoped pull returns exactly what devices
-- already see and nothing disappears from a phone when this deploys.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id) ON DELETE SET NULL;

-- teamScopeSql runs `IN (SELECT team_id FROM team_members WHERE user_id = $n)` for
-- three tables on every non-privileged pull AND full download; the push guard adds a
-- per-entry is_manager lookup. Without these these are sequential scans per request.
CREATE INDEX IF NOT EXISTS team_members_user_idx      ON team_members(user_id);
CREATE INDEX IF NOT EXISTS team_members_team_user_idx ON team_members(team_id, user_id);
CREATE INDEX IF NOT EXISTS jobs_team_idx              ON jobs(team_id);

-- Watermark touch. Incremental /sync/pull selects `WHERE updated_at > $since`, so a
-- device that misses the one-time client purge would never be re-sent rows it still
-- holds — they sit below its watermark forever. Bumping updated_at forces every
-- teams/team_members row back through the (now scoped) incremental pull exactly once.
UPDATE teams        SET updated_at = NOW();
UPDATE team_members SET updated_at = NOW();
