-- Migration 039: configurable team/role-based dashboards (Wave B / D1).
--   dashboard_presets           — org-synced, admin-managed dashboard layouts. A
--                                 preset's `layout` is a JSON array of blocks (see
--                                 apps/mobile/src/dashboard/widgets.ts LayoutBlock),
--                                 stored as TEXT to mirror the mobile SQLite column
--                                 exactly (no JSONB re-stringify through the sync
--                                 layer — same idiom as taxonomy_types.meta /
--                                 label_templates.fields). Writes are gated on
--                                 system_settings via syncPolicy OPERATION_PERM;
--                                 reads are open to every synced device.
--   users.dashboard_preset_id   — per-user override assignment (highest precedence).
--   role_settings.dashboard_preset_id — per-role assignment (fallback under the
--                                 per-user one). Both nullable; NULL → built-in
--                                 DEFAULT_LAYOUT, so an unassigned user's dashboard
--                                 is unchanged.
CREATE TABLE IF NOT EXISTS dashboard_presets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  layout      TEXT NOT NULL DEFAULT '[]',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS dashboard_preset_id TEXT;
ALTER TABLE role_settings ADD COLUMN IF NOT EXISTS dashboard_preset_id TEXT;
