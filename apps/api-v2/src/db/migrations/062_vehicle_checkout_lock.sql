-- Migration 062: vehicles.checkout_locked (#157). Mirrors mobile 050.
-- When TRUE, only the vehicle's owner (locations.owner_user_id) or tier-3+
-- org authority may open a checkout session; the vehicle stays visible on
-- every listing surface. BOOLEAN like truck_mount (mapped to 0/1 on the
-- device by pull.ts rowToValues). SYNCED — added to VEHICLES_COLS in
-- lib/syncPolicy.ts in the same change. Column-add only with a default →
-- no backfill, no seed-watermark risk.
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS checkout_locked BOOLEAN NOT NULL DEFAULT FALSE;
