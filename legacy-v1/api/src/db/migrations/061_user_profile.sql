-- Migration 061: self-service profile (role-dashboards spec §5).
--
-- users.phone — optional contact number. SYNCED (added to USERS_COLS in
-- lib/syncPolicy.ts in the same change) so every device can display it.
-- Stored normalized by PUT /me/phone (optional leading '+', 7–15 digits);
-- format is enforced at the API layer, not the DB. Column-add only → no
-- seed-watermark risk.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;

-- Pending self-service email changes (POST /me/email/request-code → confirm).
-- One pending change per user (user_id PK — a new request overwrites the old).
-- code_hash is the bcrypt hash of the 6-digit code emailed to the NEW address;
-- NULL means SMTP was unavailable at request time ({sent:false} fallback) and
-- /me/email/confirm accepts the matching email without a code. Server-only
-- table: never synced, never exposed through /sync.
CREATE TABLE IF NOT EXISTS user_email_changes (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  code_hash  TEXT,
  expires_at TIMESTAMPTZ NOT NULL
);
