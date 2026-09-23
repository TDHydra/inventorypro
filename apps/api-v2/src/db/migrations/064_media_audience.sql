-- Migration 064: media pool-share audience (#87/#148). Mirrors mobile 052.
-- audience: 'team' | 'everyone' | 'users' — TEXT, NEVER a PG enum (enum cols
-- are TEXT on mobile SQLite; remapping enum values crash-loops the API).
-- audience_user_ids: JSON array of user UUIDs (TEXT), only when audience='users'.
-- NULL on both = job/entity photo (legacy rows unaffected — no updated_at bump,
-- so no re-download storm; pool rows are only ever created after this deploys).
-- SYNCED columns: server pull uses SELECT * for media (no _COLS list) and push
-- is DB-introspected, so no sync.ts column-list edit is needed server-side;
-- mobile pull.ts IS hardcoded — see mobile migration 052 (same change set).
ALTER TABLE media ADD COLUMN IF NOT EXISTS audience TEXT;
ALTER TABLE media ADD COLUMN IF NOT EXISTS audience_user_ids TEXT;
CREATE INDEX IF NOT EXISTS idx_media_pool ON media (entity_type, audience) WHERE entity_type = 'pool';
