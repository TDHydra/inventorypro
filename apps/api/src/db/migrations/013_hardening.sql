-- Migration 013: P6 hardening — job external reference number + idempotency ledger.
-- jobs.reference_number is a manual/external reference (insurance claim / customer PO),
-- distinct from the internal jobs.job_number.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS reference_number TEXT;

-- Server-only dedup ledger for idempotent delta-based stock pushes (keyed by outbox entry UUID).
-- NOT synced; not in any sync list.
CREATE TABLE IF NOT EXISTS processed_outbox (
  entry_id     UUID PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS processed_outbox_processed_at_idx ON processed_outbox(processed_at);
