import type { SqlDb } from '../types';

// Migration 051: job_assignments (#160) — jobs assigned to a SUBTEAM (crew) or
// to an individual user (techs without a crew). Mirrors API migration 063.
// Membership resolves at READ time from team_members.subteam_id, so a crew's
// helpers are automatically included and stay current — no per-user rows.
// Soft FKs (no REFERENCES on cross-synced ids — sync-order-safe, subteams
// precedent). assignee_kind is TEXT 'user' | 'subteam' (never an enum).
// active 0/1: unassign is a soft-delete (active = 0), rows stay for history —
// DELETE is not part of the sync contract (subteams precedent).
export const migration = {
  version: 51,
  up: (db: SqlDb): void => {
    db.executeSync(`CREATE TABLE IF NOT EXISTS job_assignments (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      assignee_kind TEXT NOT NULL,
      assignee_id TEXT NOT NULL,
      assigned_by TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT
    )`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS job_assignments_job_idx ON job_assignments(job_id)`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS job_assignments_assignee_idx ON job_assignments(assignee_id)`);
  },
};
