-- Migration 067: vehicle fuel gauge (#174). Mirrors mobile 055.
-- INTEGER 0-100 (never a PG enum), same drag-to-fill idiom as debris_level
-- (065). No backfill, no updated_at bump — the 0 default converges
-- identically on all three stores (no re-download storm).
-- Deliberately NOT auto-set on fuel_up receipts: partial fills would make it
-- wrong (see docs/superpowers/plans/2026-07-25-backlog-12-items-waves.md Risks #7).
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS fuel_level INTEGER NOT NULL DEFAULT 0;
