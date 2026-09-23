-- Server-only notification idempotency ledger. NOT synced (absent from
-- ALLOWED_TABLES/FULL_TABLES/pull.ts). A trigger fires only if its key is absent;
-- low-stock deletes its key to re-arm.
CREATE TABLE IF NOT EXISTS notification_dedup (
  event_key   TEXT PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
