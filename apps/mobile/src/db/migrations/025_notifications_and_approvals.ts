import type { SqlDb } from '../types';

// Migration 025: synced notifications inbox + approvals workflow. Mirrors API
// migration 032. SQLite has no native uuid/timestamptz — those columns are TEXT
// here — and no REFERENCES (server owns FK integrity). Both tables sync:
//   notifications      — per-user inbox; pull scoped to the caller; only read_at
//                        is client-writable (server enforces via syncPolicy).
//   approval_requests  — org-wide two-way review flags.
export const migration = {
  version: 25,
  up: (db: SqlDb): void => {
    db.executeSync(`CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      data TEXT,
      read_at TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON notifications (user_id, created_at DESC)`);

    db.executeSync(`CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      requester_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'manual',
      title TEXT NOT NULL,
      detail TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      decided_by TEXT,
      decided_at TEXT,
      decision_note TEXT,
      entity_type TEXT,
      entity_id TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS approval_requests_status_idx ON approval_requests (status, updated_at DESC)`);
  },
};
