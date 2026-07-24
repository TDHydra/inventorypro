-- Migration 065: vehicle options wave (#152/#155/#167). Mirrors mobile 053.
-- TEXT/BOOLEAN/INTEGER only — never a PG enum (prod crash-loop trap).
--   debris_option: per-vehicle toggle like truck_mount (#152)
--   debris_level:  0-100 drag-to-fill level (#152)
--   open_checkout: owner-assigned vehicles are opt-in for general checkout
--                  (#155; default false = existing owned vehicles go closed on
--                  deploy day — user-approved in the phase-0 spec)
--   locked_by:     who set checkout_locked (#167); NULL = legacy pre-hierarchy
--                  lock (anyone passing canManageVehicle may unlock)
-- No backfill: defaults converge identically on all three stores, so no
-- updated_at bump (no re-download storm).
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS debris_option BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS debris_level INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS open_checkout BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS locked_by UUID;
