-- Migration 080: per-role idle re-auth (#244 / idea 31). Mirrors mobile
-- migration 066. 0 = disabled (DEFAULT for every existing + new role); every
-- row on both sides starts at the same value with no divergent seeding, so no
-- updated_at touch is needed (house rule 6 only applies when a migration
-- changes existing row DATA another device needs to see).
--
-- Deliberately independent from — and never cross-validated against — the
-- org-wide idle_timeout_minutes auto-logout setting: this column only gates a
-- PIN re-prompt while the session stays intact, never a forced sign-out.
ALTER TABLE role_settings ADD COLUMN IF NOT EXISTS idle_reauth_minutes INT NOT NULL DEFAULT 0
  CHECK (idle_reauth_minutes BETWEEN 0 AND 480);
