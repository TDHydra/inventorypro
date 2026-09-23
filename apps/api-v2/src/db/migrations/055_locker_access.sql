-- Migration 055: locker access grants (#126). Mirrors mobile migration 043.
-- One row = "this user may take stock from this Locker-typed location". Writes
-- are owner-or-org-authority only, and the negative-delta ADJUST guard in
-- routes/sync.ts consults this table (hard server enforcement — user decision
-- 2026-07-18). Soft FKs (no constraints on cross-synced refs); composite PK is
-- the sync conflict target.
CREATE TABLE IF NOT EXISTS locker_access (
  location_id  UUID NOT NULL,
  user_id      UUID NOT NULL,
  granted_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (location_id, user_id)
);
CREATE INDEX IF NOT EXISTS locker_access_user_idx ON locker_access(user_id);
