import type { SqlDb } from '../types';

// Migration 024: local-only telemetry ring buffer. Mirrors API migration 029
// (telemetry_events) but this table never syncs — it's drained by
// flushTelemetry() (src/telemetry/flush.ts) and rows are deleted once sent.
// `seq` autoincrement drives oldest-first eviction (cap) + FIFO flush order.
export const migration = {
  version: 24,
  up: (db: SqlDb): void => {
    db.executeSync(`CREATE TABLE IF NOT EXISTS telemetry_buffer (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      type       TEXT NOT NULL, name TEXT NOT NULL, screen TEXT,
      props      TEXT, client_ts TEXT NOT NULL
    )`);
  },
};
