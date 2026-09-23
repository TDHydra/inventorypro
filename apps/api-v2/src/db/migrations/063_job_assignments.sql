-- Migration 063: job_assignments (#160). Mirrors mobile 051.
-- Jobs are assigned to a SUBTEAM (crew) — or to an individual user for techs
-- without a crew. Crew membership resolves at READ time from
-- team_members.subteam_id, so helpers are automatically included and stay
-- current; no per-user assignment rows for crews.
--
-- assignee_kind is TEXT 'user' | 'subteam' — NEVER a PG enum (enum cols are
-- TEXT on mobile SQLite; remapping enum values crash-loops the API).
-- Soft FK on job_id/assignee_id (sync-order-safe, subteams precedent);
-- assigned_by is attribution (forced to the caller in syncPolicy.ts).
-- Unassign is a soft-delete (active = FALSE) — rows stay for history.
-- SYNCED table: registered in routes/sync.ts (ALLOWED_TABLES + FULL_TABLES)
-- and lib/syncPolicy.ts (JOB_ASSIGNMENTS_COLS, OPERATION_PERM create_jobs,
-- ATTRIBUTION_COLUMNS) in the same change. Table-add only → no backfill,
-- no seed-watermark risk.
CREATE TABLE IF NOT EXISTS job_assignments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL,
  assignee_kind TEXT NOT NULL,
  assignee_id   UUID NOT NULL,
  assigned_by   UUID,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS job_assignments_job_idx ON job_assignments(job_id);
CREATE INDEX IF NOT EXISTS job_assignments_assignee_idx ON job_assignments(assignee_id);
