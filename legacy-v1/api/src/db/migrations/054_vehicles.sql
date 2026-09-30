-- Migration 054: vehicles (#125) — real state for Vehicle-typed locations.
-- Mirrors mobile migration 042. Three tables, all soft-FK (no constraints on
-- cross-synced refs, maintenance_events precedent):
--   vehicles                 1:1 extension of a Vehicle-type location (PK = the
--                            location id): truck mount, water state
--                            ('full'/'empty_clean' — TEXT, never a PG enum),
--                            model label + taxonomy soft-FK, notes.
--   vehicle_service_records  service log (target 'vehicle'/'truck_mount'/'both');
--                            cost is financial (gated behind view_financial_data
--                            in syncPolicy, maintenance_events pattern).
--   vehicle_checkouts        individual-holder sessions; job_id nullable and
--                            editable after the fact; open session = checked_in_at
--                            IS NULL (close-only takeover guarded in routes/sync.ts).
CREATE TABLE IF NOT EXISTS vehicles (
  location_id  UUID PRIMARY KEY,
  truck_mount  BOOLEAN NOT NULL DEFAULT FALSE,
  water_state  TEXT,
  model        TEXT,
  model_id     UUID,
  notes        TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vehicle_service_records (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_location_id  UUID NOT NULL,
  target               TEXT NOT NULL DEFAULT 'vehicle',
  event_date           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  type                 TEXT NOT NULL,
  notes                TEXT,
  odometer             INTEGER,
  cost                 DECIMAL(10,2),
  created_by           UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS vehicle_service_records_vehicle_idx
  ON vehicle_service_records(vehicle_location_id);

CREATE TABLE IF NOT EXISTS vehicle_checkouts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_location_id  UUID NOT NULL,
  user_id              UUID NOT NULL,
  job_id               UUID,
  checked_out_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checked_in_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS vehicle_checkouts_vehicle_idx
  ON vehicle_checkouts(vehicle_location_id);
CREATE INDEX IF NOT EXISTS vehicle_checkouts_user_idx
  ON vehicle_checkouts(user_id);

-- #81 seed: vehicle_model taxonomy. FIXED UUIDs shared VERBATIM with mobile
-- migration 042 so both sides converge on sync (same primary key → pull upsert
-- is a no-op, no duplicate rows — migration 036 pattern). Idempotent by id;
-- explicit updated_at NOW() so already-enrolled devices pick the rows up on the
-- next incremental pull (seed-sync watermark rule).
INSERT INTO taxonomy_types (id, category, label, icon, sort_order, updated_at)
SELECT 'c4a81000-0000-4000-8000-000000000001', 'vehicle_model', 'Chevy Cargo Van', '🚐', 0, NOW()
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE id = 'c4a81000-0000-4000-8000-000000000001');

INSERT INTO taxonomy_types (id, category, label, icon, sort_order, updated_at)
SELECT 'c4a81000-0000-4000-8000-000000000002', 'vehicle_model', 'Chevy Box Truck', '🚚', 1, NOW()
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE id = 'c4a81000-0000-4000-8000-000000000002');

INSERT INTO taxonomy_types (id, category, label, icon, sort_order, updated_at)
SELECT 'c4a81000-0000-4000-8000-000000000003', 'vehicle_model', 'Ford Transit 350', '🚐', 2, NOW()
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE id = 'c4a81000-0000-4000-8000-000000000003');

INSERT INTO taxonomy_types (id, category, label, icon, sort_order, updated_at)
SELECT 'c4a81000-0000-4000-8000-000000000004', 'vehicle_model', 'Ford Transit City Van', '🚐', 3, NOW()
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE id = 'c4a81000-0000-4000-8000-000000000004');

INSERT INTO taxonomy_types (id, category, label, icon, sort_order, updated_at)
SELECT 'c4a81000-0000-4000-8000-000000000005', 'vehicle_model', 'Ford Maverick', '🛻', 4, NOW()
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE id = 'c4a81000-0000-4000-8000-000000000005');
