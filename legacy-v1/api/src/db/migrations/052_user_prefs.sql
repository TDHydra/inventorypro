-- Per-user synced preferences (#112). Mirrors mobile migration 040. One row per
-- user; theme is the selected theme id. TEXT deliberately — never an enum
-- (remapping enum values crash-loops the API on boot; see the unit_category
-- incident). Self-write is enforced in syncPolicy via attribution (user_id is
-- forced to the authenticated caller on INSERT), and pull is scoped so a device
-- only downloads its own user's row.
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
