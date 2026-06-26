# Sync migration checklist
The sync layer uses HARDCODED column lists, not `SELECT *`. Any migration that adds a column to a
**synced** table MUST also update, in the same change:
1. `apps/api/src/routes/sync.ts` — push path (and `activity_log`'s explicit INSERT, which is fully hardcoded).
2. `apps/mobile/src/sync/pull.ts` — both `TABLE_UPSERT_SQL` (the INSERT OR REPLACE column list + placeholders)
   AND `rowToValues` (the matching value array). Column count must match placeholder count.
Skipping this silently drops the new column on sync (push error or pull omission → data loss / never propagates).
Burned us on migration 008 (jobs work-order fields) and 009 (location coords). Verify column/placeholder parity.
