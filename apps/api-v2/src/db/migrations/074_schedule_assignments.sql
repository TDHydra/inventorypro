-- Migration 074: schedule_assignments (#184). Mirrors mobile 059.
-- Employee day schedule graphical assignment board: each row is ONE employee's
-- block of time on ONE day, assigned to either a JOB (assignment_kind='job',
-- job_id set) or a PRODUCTION MANAGER contact (assignment_kind='manager',
-- manager_id set) — never both (enforced in the query layer, not a CHECK
-- constraint). assignment_kind is TEXT 'job' | 'manager' — NEVER a PG enum
-- (enum cols are TEXT on mobile SQLite; remapping enum values crash-loops the
-- API — job_assignments precedent).
-- day is a plain TEXT date key ('YYYY-MM-DD'), the business-calendar day the
-- scheduler is building — not a timezone-converted instant (on_call_shifts
-- week_start precedent). start_minute/end_minute are minutes-since-midnight
-- (0-1440) on that day's wall clock, so overlap math and drag/resize snapping
-- are plain integer arithmetic with no TZ conversion.
-- Soft FKs on employee_id/job_id/manager_id (no REFERENCES — sync-order-safe,
-- job_assignments precedent); created_by is attribution (forced to the caller
-- in syncPolicy.ts). Clearing a slot is a soft-delete (active = FALSE) — rows
-- stay for history, same as job_assignments/on_call_shifts. Overlap prevention
-- is APPLICATION-level only (queries/schedule.ts), never a DB constraint — two
-- offline devices can legitimately race to create overlapping rows before
-- either syncs; see the #184 plan's edge-cases notes.
-- SYNCED table: registered in routes/sync.ts (ALLOWED_TABLES + FULL_TABLES) and
-- lib/syncPolicy.ts (SCHEDULE_ASSIGNMENTS_COLS, OPERATION_PERM manage_schedule,
-- ATTRIBUTION_COLUMNS) in the same change. Table-add only → no backfill, no
-- seed-watermark risk.
CREATE TABLE IF NOT EXISTS schedule_assignments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID NOT NULL,
  day             TEXT NOT NULL,
  start_minute    INTEGER NOT NULL,
  end_minute      INTEGER NOT NULL,
  assignment_kind TEXT NOT NULL,
  job_id          UUID,
  manager_id      UUID,
  note            TEXT,
  created_by      UUID,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS schedule_assignments_day_idx ON schedule_assignments(day);
CREATE INDEX IF NOT EXISTS schedule_assignments_employee_day_idx ON schedule_assignments(employee_id, day);
CREATE INDEX IF NOT EXISTS schedule_assignments_job_idx ON schedule_assignments(job_id);
