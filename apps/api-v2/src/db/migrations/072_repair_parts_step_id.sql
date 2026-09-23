-- Migration 072: link repair_parts to the troubleshooting step it was
-- consumed under (#178 Part 4). Nullable — parts used before any step is
-- logged (or pre-existing rows) simply carry no step link. No FK (repair_parts
-- /028's own sync-order-safe design; step_id mirrors that precedent).
ALTER TABLE repair_parts ADD COLUMN IF NOT EXISTS step_id UUID;
