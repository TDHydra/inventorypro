-- #173: Job media capture flow — a synced "rooms" catalog (e.g. Kitchen,
-- Garage, Basement) so a photo taken on a job can be tagged to a specific
-- room, plus the media.room_id link. media already has a free-text
-- `caption` column (surfaced as "Note" in QuickPhotoFlow/MediaGallery) —
-- deliberately reused for the note field rather than adding a duplicate
-- column here.
CREATE TABLE IF NOT EXISTS rooms (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- No FK to media on purpose (matches the repair_steps/repair_id convention):
-- rooms and media can pull/push independently of arrival order.
ALTER TABLE media ADD COLUMN IF NOT EXISTS room_id UUID NULL;
