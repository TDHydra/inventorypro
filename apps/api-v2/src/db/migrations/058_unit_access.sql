-- Migration 058: per-action unit access (#122 Phase A1). Mirrors mobile 046.
-- Generalizes locker_access to BOTH vehicles and lockers with per-action
-- booleans. locker_access is kept (deprecated — the ADJUST guard and access
-- kernel move to unit_access in code; nothing drops the old table). Soft FKs;
-- composite PK is the sync conflict target (locker_access pattern, 055).
-- Copy: an existing grant = view+add+remove+move (approved design, section B).
-- updated_at = NOW() on copied rows so enrolled devices pull them (watermark).
CREATE TABLE IF NOT EXISTS unit_access (
  location_id      UUID NOT NULL,
  user_id          UUID NOT NULL,
  can_view         BOOLEAN NOT NULL DEFAULT TRUE,
  can_add          BOOLEAN NOT NULL DEFAULT FALSE,
  can_remove       BOOLEAN NOT NULL DEFAULT FALSE,
  can_move         BOOLEAN NOT NULL DEFAULT FALSE,
  can_edit_details BOOLEAN NOT NULL DEFAULT FALSE,
  can_grant        BOOLEAN NOT NULL DEFAULT FALSE,
  granted_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (location_id, user_id)
);
CREATE INDEX IF NOT EXISTS unit_access_user_idx ON unit_access(user_id);

INSERT INTO unit_access (location_id, user_id, can_view, can_add, can_remove, can_move, can_edit_details, can_grant, granted_by, created_at, updated_at)
SELECT location_id, user_id, TRUE, TRUE, TRUE, TRUE, FALSE, FALSE, granted_by, created_at, NOW()
  FROM locker_access
ON CONFLICT (location_id, user_id) DO NOTHING;
