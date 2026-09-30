-- Migration 028: repair SLA fields (assignee, cost, due date) + repair_parts
-- (inventory consumed by a repair). No FK on entity ids — matches the existing
-- repairs table's sync-order-safe design (rows can pull/push out of order).
ALTER TABLE repairs ADD COLUMN IF NOT EXISTS assignee_id UUID;
ALTER TABLE repairs ADD COLUMN IF NOT EXISTS cost DECIMAL(10,2);
ALTER TABLE repairs ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS repair_parts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repair_id    UUID NOT NULL,
  item_id      UUID NOT NULL,
  qty          DECIMAL(10,3) NOT NULL,
  unit         TEXT NOT NULL,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
