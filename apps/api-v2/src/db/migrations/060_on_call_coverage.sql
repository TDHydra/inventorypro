-- Migration 060: on-call coverage/time-off (#122 Phase C). Mirrors mobile 048.
-- Coverage rows are PM-authored ("X is covering for Y from A to B"); dates are
-- TEXT ISO yyyy-mm-dd (string-comparable, the week_start convention). user_off/
-- covering_user are soft FKs to users (sync-order-safe, no constraint).
CREATE TABLE IF NOT EXISTS on_call_coverage (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date_start    TEXT NOT NULL,
  date_end      TEXT NOT NULL,
  user_off      UUID,
  covering_user UUID,
  note          TEXT,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Settings defaults (admin-editable via the synced app_config path). updated_at
-- is NOW() so already-enrolled devices receive the seeds via incremental pull
-- (the migration-seeded-rows watermark gotcha).
INSERT INTO app_config (key, value, updated_at) VALUES
  ('on_call_week_boundary', '{"day":4,"hour":8}', NOW()),
  ('on_call_rotation', '[]', NOW())
ON CONFLICT (key) DO NOTHING;

-- Re-key existing Monday-keyed shifts to the Thursday-boundary week that
-- CONTAINS that Monday (Monday minus 4 days = the preceding Thursday). A
-- constant shift preserves UNIQUE(week_start). Guarded to DOW=1 so the
-- statement is a no-op on already-boundary-keyed rows. updated_at bumps so
-- enrolled devices pull the re-keyed rows.
UPDATE on_call_shifts
   SET week_start = to_char(week_start::date - 4, 'YYYY-MM-DD'),
       updated_at = NOW()
 WHERE EXTRACT(DOW FROM week_start::date) = 1;
