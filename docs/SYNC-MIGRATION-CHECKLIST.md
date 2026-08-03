# Sync migration checklist
The sync layer uses HARDCODED column lists, not `SELECT *`. Any migration that adds a column to a
**synced** table MUST also update, in the same change:
1. `apps/api/src/routes/sync.ts` — push path (and `activity_log`'s explicit INSERT, which is fully hardcoded).
2. `apps/mobile/src/sync/pull.ts` — both `TABLE_UPSERT_SQL` (the INSERT OR REPLACE column list + placeholders)
   AND `rowToValues` (the matching value array). Column count must match placeholder count.
Skipping this silently drops the new column on sync (push error or pull omission → data loss / never propagates).
Burned us on migration 008 (jobs work-order fields) and 009 (location coords). Verify column/placeholder parity.

## Expand/contract discipline (required since #247 — blue-green is the default API deploy)

Blue-green deploys (see `infra/README.md`) mean the OLD color keeps serving live traffic,
on the OLD code, against the NEW (already-migrated) schema, for a short window after the
new color's migrations run and before the old color is stopped. #238's migration advisory
lock only prevents two containers double-applying the *same* migration concurrently — it
does **not** guarantee the migration is backward-compatible with the code still running in
that window. Concretely:

- A migration that **drops or renames** a column/table the currently-deployed (old) code
  still reads or writes will break the old color mid-flip, not just the new one.
- A migration that **adds a NOT NULL column with no default** likewise breaks any INSERT the
  old code issues without that column.

Any migration landing while blue-green is the default upgrade path must be
**expand/contract-compatible**: additive-only (nullable columns, new tables, new indexes) in
the deploy that ships the new code path, with any destructive/renaming cleanup split into a
**later, separate** deploy once no old-code color can possibly still be running. This is the
same discipline any rolling deploy needs — it isn't new to this codebase, but it's now
load-bearing rather than a nice-to-have, since every API deploy is a blue-green flip.
