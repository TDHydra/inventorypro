-- Migration 081: equipment/item cleanliness ("filth") state (#248). Mirrors
-- mobile migration 067. Additive-only, safe defaults — no backfill/watermark
-- touch needed (mig-055 precedent).
--
-- equipment_units.cleanliness TEXT NOT NULL DEFAULT 'clean' — TEXT not enum
-- (house rule: no Postgres ENUM on synced columns), no CHECK so a future
-- third state doesn't need another migration. jobs_since_clean INTEGER NOT
-- NULL DEFAULT 0 — incremented client-side at job check-in, offline-first,
-- no server trigger.
--
-- inventory_items.needs_cleaning BOOLEAN NOT NULL DEFAULT FALSE — mirrors the
-- `returnable` precedent (migration 005). clean_after_jobs INTEGER NULL — the
-- auto-dirty cadence (NULL = off, mirrors min_qty_alert's 0->NULL convention).
ALTER TABLE equipment_units ADD COLUMN IF NOT EXISTS cleanliness TEXT NOT NULL DEFAULT 'clean';
ALTER TABLE equipment_units ADD COLUMN IF NOT EXISTS jobs_since_clean INT NOT NULL DEFAULT 0;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS needs_cleaning BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS clean_after_jobs INT;
