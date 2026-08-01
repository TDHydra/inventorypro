import type { SqlDb } from '../types';

// Migration 061: outbox.denied (#202). A PERMANENT sync-push rejection (an
// authorization denial — engine.ts's PERMANENT_REJECTION classification) used
// to be handled by deleting the outbox row outright (dropOutboxEntry): the
// change vanished with no trace and nothing for the user to see. denied=1
// marks the row instead of deleting it, and reuses the existing last_error
// column to carry a human-readable message (see sync/denialMessages.ts) so
// SyncIndicator can list what was refused and offer an explicit Dismiss
// (discard) action.
//
// outbox is LOCAL-ONLY — it is never pushed or pulled — so unlike a migration
// on a synced table this does NOT need updates to apps/api/src/routes/sync.ts
// or apps/mobile/src/sync/pull.ts (see docs/SYNC-MIGRATION-CHECKLIST.md, which
// is scoped to tables that actually sync).
export const migration = {
  version: 61,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE outbox ADD COLUMN denied INTEGER NOT NULL DEFAULT 0`);
  },
};
