import type { SqlDb } from '../types';

// Migration 036: media hub columns. Mirrors API migration 044.
//
// location_note is the per-image "where was this taken" field ("master
// bedroom"). updated_at is what lets media EDITS sync at all: the server's
// incremental cursor for media was created_at (the table had no updated_at),
// so an edited row never re-synced — the backfill (= created_at) keeps
// existing rows below every device's watermark while future edits propagate.
export const migration = {
  version: 36,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE media ADD COLUMN location_note TEXT`);
    db.executeSync(`ALTER TABLE media ADD COLUMN updated_at TEXT`);
    db.executeSync(`UPDATE media SET updated_at = created_at`);
  },
};
