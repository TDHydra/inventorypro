-- Migration 071: repair troubleshooting steps log (#178 v1). Immutable
-- per-step record (action tried + result) attached to a repair ticket. No FK
-- on repair_id — matches repair_parts' (028) sync-order-safe design, so a
-- step can pull/push before or after its parent repair row.
CREATE TABLE IF NOT EXISTS repair_steps (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repair_id  UUID NOT NULL,
  action     TEXT NOT NULL,
  result     TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS repair_steps_repair_id_idx ON repair_steps (repair_id);
