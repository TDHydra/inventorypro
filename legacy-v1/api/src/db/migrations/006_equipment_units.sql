ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS unit_tracked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS tag_prefix TEXT;

CREATE TABLE IF NOT EXISTS equipment_units (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id             UUID NOT NULL REFERENCES inventory_items(id),
  asset_tag           TEXT NOT NULL,
  serial_number       TEXT,
  status              TEXT NOT NULL DEFAULT 'available',
  current_location_id UUID REFERENCES locations(id),
  current_job_id      UUID REFERENCES jobs(id),
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS equipment_units_asset_tag_idx ON equipment_units(asset_tag);
CREATE INDEX IF NOT EXISTS equipment_units_item_idx ON equipment_units(item_id);
