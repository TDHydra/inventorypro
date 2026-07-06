-- Migration 033: equipment lifecycle — maintenance_events (service/repair log per
-- unit) + depreciation/service-schedule fields on equipment_units. No FK on
-- maintenance_events.unit_id — matches repair_parts' (028) sync-order-safe design
-- so rows can pull/push out of order without a parent-first constraint.
ALTER TABLE equipment_units ADD COLUMN IF NOT EXISTS purchase_price DECIMAL(10,2);
ALTER TABLE equipment_units ADD COLUMN IF NOT EXISTS acquired_at TIMESTAMPTZ;
ALTER TABLE equipment_units ADD COLUMN IF NOT EXISTS useful_life_months INTEGER;
ALTER TABLE equipment_units ADD COLUMN IF NOT EXISTS salvage_value DECIMAL(10,2);
ALTER TABLE equipment_units ADD COLUMN IF NOT EXISTS depreciation_method TEXT;
ALTER TABLE equipment_units ADD COLUMN IF NOT EXISTS next_service_at TIMESTAMPTZ;
ALTER TABLE equipment_units ADD COLUMN IF NOT EXISTS service_interval_months INTEGER;

CREATE TABLE IF NOT EXISTS maintenance_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id      UUID NOT NULL,
  event_date   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  type         TEXT NOT NULL,
  notes        TEXT,
  cost         DECIMAL(10,2),
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
