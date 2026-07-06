-- Server-only push token registry. NOT synced (absent from ALLOWED_TABLES/
-- FULL_TABLES/pull.ts). One row per (user, device token); disabled when Expo
-- reports the token unregistered.
CREATE TABLE IF NOT EXISTS device_push_tokens (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expo_push_token TEXT NOT NULL UNIQUE,
  platform       TEXT,
  device_id      TEXT,
  disabled       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS device_push_tokens_user_idx ON device_push_tokens(user_id) WHERE disabled = FALSE;
