-- Media hub: per-image location note + updated_at so edits can sync.
--
-- media had NO updated_at, so routes/sync.ts used created_at as its incremental
-- cursor — meaning an UPDATE to a media row never re-synced to other devices.
-- The backfill sets updated_at = created_at: every existing row stays at or
-- below any enrolled device's cursor (no re-download storm), while future
-- edits get NOW() and propagate. The cursor switch itself is in routes/sync.ts.
ALTER TABLE media ADD COLUMN IF NOT EXISTS location_note TEXT;
ALTER TABLE media ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
UPDATE media SET updated_at = created_at;
CREATE INDEX IF NOT EXISTS idx_media_updated_at ON media (updated_at);
