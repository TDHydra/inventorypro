-- Migration 056: on-call calendar (#128). Mirrors mobile migration 044.
-- One crew (subteam) covers each week: UNIQUE(week_start) + sync conflict
-- target 'week_start' make reassignment an upsert — a second assignment for
-- the same week REPLACES the first instead of duplicating it. week_start is a
-- TEXT date key (ISO yyyy-mm-dd, the Monday of the week — weekMath.ts owns the
-- computation). subteam_id is a soft FK (no constraint, sync-order-safe).
CREATE TABLE IF NOT EXISTS on_call_shifts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subteam_id  UUID,
  week_start  TEXT NOT NULL UNIQUE,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
