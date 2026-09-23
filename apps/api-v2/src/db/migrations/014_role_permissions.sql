-- Migration 014: P5 5a — dynamic role→permission assignment.
-- role_settings.permission_overrides holds only deviations from ROLE_DEFAULTS
-- ({perm: bool}); empty = pure default. role_settings is already synced (conflict `role`).
ALTER TABLE role_settings ADD COLUMN IF NOT EXISTS permission_overrides JSONB NOT NULL DEFAULT '{}';
