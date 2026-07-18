-- Migration 053: subteams (#123) — 2-person crews inside a team (lead + helper,
-- e.g. Frank Turner + Matt = "TV/FT"). Mirrors mobile migration 041.
-- No FK on team_id (soft FK — sync-order-safe, maintenance_events precedent).
-- team_members gains subteam_id/subteam_role (TEXT, never PG enums) so a member
-- row records which crew it belongs to and whether it is the 'lead' or 'helper'.
CREATE TABLE IF NOT EXISTS subteams (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     UUID NOT NULL,
  name        TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS subteams_team_idx ON subteams(team_id);

ALTER TABLE team_members ADD COLUMN IF NOT EXISTS subteam_id TEXT;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS subteam_role TEXT;
