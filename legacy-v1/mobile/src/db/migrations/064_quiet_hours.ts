import type { SqlDb } from '../types';

// Migration 064: per-user quiet hours (#242). Mirrors API migration 078.
// quiet_hours_start/_end are UTC-minutes-since-midnight (0-1439), computed by
// THIS CLIENT at save time from local wall-clock + the device's current UTC
// offset — there is no timezone column anywhere in this schema, so a user who
// travels or crosses a DST boundary keeps the stale offset baked into their
// saved window until they resave the setting (see the save site in
// settings.tsx for the full tradeoff comment). NULL/NULL = disabled (the same
// "never set" convention theme/dashboard_layout already use).
// SYNCED columns (docs/SYNC-MIGRATION-CHECKLIST.md): pull.ts TABLE_UPSERT_SQL
// + rowToValues extended in the same change, plus syncPolicy's user_prefs
// projection (~L555/579).
export const migration = {
  version: 64,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE user_prefs ADD COLUMN quiet_hours_start INTEGER`);
    db.executeSync(`ALTER TABLE user_prefs ADD COLUMN quiet_hours_end INTEGER`);
  },
};
