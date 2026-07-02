-- Migration 034: label_templates — org-synced, admin-managed custom label layouts
-- for the visual label designer. `fields` is a JSON array of positioned fields
-- (see apps/mobile/src/labels/positioned.ts LabelField), stored as TEXT to mirror
-- the mobile SQLite column exactly (no JSONB re-stringify through the sync layer,
-- same idiom as taxonomy_types.meta). Writes are gated on system_settings via
-- syncPolicy OPERATION_PERM; reads are open to every synced device.
CREATE TABLE IF NOT EXISTS label_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  width_in    NUMERIC(6,3) NOT NULL,
  height_in   NUMERIC(6,3) NOT NULL,
  dpi         INTEGER NOT NULL DEFAULT 203,
  fields      TEXT NOT NULL DEFAULT '[]',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed one built-in positioned template (fixed id, ASCII-only) so the custom
-- render path is usable/verifiable before the visual editor ships. Syncs to
-- every device via /sync/pull + full-download. 4x2in: QR left, name + tag right.
INSERT INTO label_templates (id, name, width_in, height_in, dpi, fields, created_by)
VALUES (
  'f0f0f0f0-0000-4000-8000-000000000001',
  'Standard 4x2 (QR + name + tag)',
  4.0, 2.0, 203,
  '[{"id":"qr","type":"qr","x":0.03,"y":0.1,"w":0.44,"h":0.8},{"id":"nm","type":"item_name","x":0.5,"y":0.15,"w":0.47,"h":0.35,"fontPt":12,"align":"left"},{"id":"tag","type":"asset_tag","x":0.5,"y":0.55,"w":0.47,"h":0.3,"fontPt":10,"align":"left"}]',
  NULL
)
ON CONFLICT (id) DO NOTHING;

