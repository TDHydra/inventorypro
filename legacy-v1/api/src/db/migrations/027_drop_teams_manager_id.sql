-- teams.manager_id is deprecated/replaced by team_members.is_manager (see
-- migration 015_team_managers.sql, which already migrated any single manager_id
-- into a flagged team_members row). Nothing reads or writes manager_id anymore
-- (routes/teams.ts updated in the same change) — drop the dead column.
ALTER TABLE teams DROP COLUMN IF EXISTS manager_id;
