import type { SqlDb } from '../types';

// Migration 059: schedule_assignments (#184) — employee day schedule graphical
// assignment board. Mirrors API migration 074.
// Each row is ONE employee's block of time on ONE day, assigned to either a JOB
// (assignment_kind='job', job_id set) or a PRODUCTION MANAGER contact
// (assignment_kind='manager', manager_id set) — never both (enforced in the
// query layer). assignment_kind is TEXT (never an enum — job_assignments
// precedent). day is a plain TEXT date key ('YYYY-MM-DD') chosen by the
// scheduler building the board, not derived from device timezone
// (on_call_shifts week_start precedent). start_minute/end_minute are
// minutes-since-midnight (0-1440) on that day's wall clock.
// Soft FKs on employee_id/job_id/manager_id (no REFERENCES — sync-order-safe).
// active 0/1: clearing a slot is a soft-delete — rows stay for history, DELETE
// is not part of the sync contract (job_assignments precedent).
export const migration = {
  version: 59,
  up: (db: SqlDb): void => {
    db.executeSync(`CREATE TABLE IF NOT EXISTS schedule_assignments (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      day TEXT NOT NULL,
      start_minute INTEGER NOT NULL,
      end_minute INTEGER NOT NULL,
      assignment_kind TEXT NOT NULL,
      job_id TEXT,
      manager_id TEXT,
      note TEXT,
      created_by TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT
    )`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS schedule_assignments_day_idx ON schedule_assignments(day)`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS schedule_assignments_employee_day_idx ON schedule_assignments(employee_id, day)`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS schedule_assignments_job_idx ON schedule_assignments(job_id)`);
  },
};
