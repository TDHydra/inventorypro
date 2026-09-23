-- Server-only behavioral telemetry sink. NOT synced to devices (absent from
-- ALLOWED_TABLES/FULL_TABLES/pull.ts). Lossy by design; pruned at 90 days.
CREATE TABLE IF NOT EXISTS telemetry_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   TEXT NOT NULL,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  device_id    TEXT,
  platform     TEXT,
  app_version  TEXT,
  type         TEXT NOT NULL,          -- screen | action | error | audit
  name         TEXT NOT NULL,
  screen       TEXT,
  props        JSONB,
  client_ts    TIMESTAMPTZ,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS telemetry_received_idx ON telemetry_events(received_at);
CREATE INDEX IF NOT EXISTS telemetry_type_name_idx ON telemetry_events(type, name);
CREATE INDEX IF NOT EXISTS telemetry_user_idx ON telemetry_events(user_id);
