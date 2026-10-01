# Sync migration checklist
The sync layer uses HARDCODED column lists, not `SELECT *`. Any migration that adds a column to a
**synced** table MUST also update, in the same change:
1. `apps/api-v2/src/routes/sync.ts` — push path (and `activity_log`'s explicit INSERT, which is fully hardcoded).
2. `packages/core/src/sync/pull.ts` (v2 moved the sync layer into @invenpro/core) — both `TABLE_UPSERT_SQL` (the INSERT OR REPLACE column list + placeholders)
   AND `rowToValues` (the matching value array). Column count must match placeholder count.
Skipping this silently drops the new column on sync (push error or pull omission → data loss / never propagates).
Burned us on migration 008 (jobs work-order fields) and 009 (location coords). Verify column/placeholder parity.

## What this means in v2 (the three files to touch, #290)

Point 2 is no longer two hand-written lists: `packages/core/src/manifest/tables.ts` IS the
contract, and `derive.ts` generates the upsert SQL, the placeholders and `rowToValues` from it.
A column added to a synced table in v2 needs:

1. **`packages/core/src/manifest/tables.ts`** — append the column to the table's `columns[]`
   (SQLite baseline DDL), to the verbatim `ddl` string, and to `pullColumns[]`. Append LAST
   everywhere, so an upgrading device ends up with the same column order a fresh install gets
   from the baseline. If the local column is `NOT NULL`, give the pull spec a `def` (or
   `coerce: 'bool'`): a client that ships before the server's migration applies pulls rows
   with the field absent, and a bare spec binds `null` → every upsert in that pull fails.
2. **`apps/mobile-v2/src/db/migrations/index.ts`** — one additive migration, and its `ALTER`
   MUST be wrapped in `hasColumn(...)`. Migration 001 builds the baseline from the CURRENT
   manifest, which already carries the new column, so on a FRESH install the column exists
   before the later migration runs; SQLite has no `ADD COLUMN IF NOT EXISTS`, and the
   unguarded `ALTER` rolls the whole install back. (There is only ONE `MIGRATIONS` array in
   v2 — `schema.ts` and `schema.web.ts` share it, so the old twin-array drift risk is gone.)
3. **`apps/api-v2/src/lib/syncPolicy.ts`** — the PULL projection. This one is still hardcoded
   per table (`JOBS_BASE`, `LOCATIONS_BASE`, `USERS_BASE`, … and their `_SENSITIVE` halves,
   the #204 column-redaction split) and is the easiest step to miss: everything else can be
   complete and green, and the column still never reaches a device because the server never
   SELECTs it. Default to BASE; only put a column in `_SENSITIVE` if withholding it degrades
   safely on the client (a `NOT NULL DEFAULT` column usually does NOT — the fallback silently
   rewrites real data).

The **push** path needs nothing: it filters payload columns against live PG introspection
(`loadTableColumns`), so a column present in PG is accepted automatically.

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
