# Vehicles Schema Phase 0 — Design (#152 / #155 / #167 / #168)

**Date:** 2026-07-23 · **Branch:** `feat/vehicles-schema-phase0` · **Board:** #152, #155, #167, #168 (all In progress)

## Goal

One schema/migration wave laying the DB groundwork for the four in-progress vehicle items, so each item's UI phase is code-only (no further migrations). Scope is schema, sync wiring, and one slice of write plumbing (`locked_by` stamping). UI for all four items is explicitly out of scope.

## Decisions (user-approved 2026-07-23)

1. **Scope:** all four items in one wave.
2. **#167:** track the locker as `locked_by` UUID; tier is resolved from the synced users/roles tables at check time (works offline, follows promotions/demotions, gives audit). No tier snapshot column.
3. **#168:** receipts extend `vehicle_service_records` rather than a new table. A gas receipt is a `type='fuel_up'` record; odometer, cost (financial-gated via `view_financial_data`), history panel, and `getFuelUps`/`getOdometerTimeline` are reused. Photo attaches through the media pipeline with a new entity type `'service_record'` whose `entity_id` is the record id.
4. **#155:** `open_checkout` defaults **false** — existing owner-assigned vehicles go closed on deploy day; owners opt shared vehicles back in. Unowned vehicles remain checkable by anyone (the flag only gates owner-assigned vehicles).

## Migrations

Exactly the two pairs reserved after media-share (#87) took mobile 052 / API 064. Re-verify next-free numbers immediately before creating files.

### Pair 1 — vehicles columns (mobile `053_vehicle_options.ts` / API `065_vehicle_options.sql`)

| Column | PG type | SQLite type | Default | Item |
|---|---|---|---|---|
| `debris_option` | BOOLEAN NOT NULL | INTEGER NOT NULL | false / 0 | #152 — per-vehicle toggle, mirrors `truck_mount` |
| `debris_level` | INTEGER NOT NULL | INTEGER NOT NULL | 0 | #152 — 0–100 fill level |
| `open_checkout` | BOOLEAN NOT NULL | INTEGER NOT NULL | false / 0 | #155 — owner-assigned vehicles opt-in |
| `locked_by` | UUID NULL | TEXT NULL | NULL | #167 — who set `checkout_locked` |

- **No backfills, no watermark UPDATEs.** Column defaults converge identically on all three stores; existing rows must not re-download.
- **Legacy-lock rule:** `checkout_locked=true` with `locked_by IS NULL` is a pre-hierarchy lock — anyone passing today's `canManageVehicle` may unlock. Nothing bricks on deploy day.
- TEXT/BOOL/INTEGER only — never a PG enum (prod crash-loop trap).

### Pair 2 — vehicle_service_records columns (mobile `054_receipt_fields.ts` / API `066_receipt_fields.sql`)

| Column | PG type | SQLite type | Default | Item |
|---|---|---|---|---|
| `payer` | TEXT NULL | TEXT NULL | NULL | #168 — 'Teams' / 'Office' / … from config list |
| `job_id` | UUID NULL | TEXT NULL | NULL | #168 — optional job, soft FK (style of `vehicle_checkouts.job_id`) |

Both nullable; existing service records are untouched (no watermark concern).

### Registration

Every mobile migration registered in **both** `apps/mobile/src/db/schema.ts` (import + version array) and `apps/mobile/src/db/schema.web.ts` (Promise.all import array) — web sql.js runs its own list.

## Non-migration schema work

### Media entity type

Add `'service_record'` to `MEDIA_ENTITY_TYPES` (`apps/api/src/lib/syncPolicy.ts:229`). That single set gates presign (`routes/media.ts` upload-url), save, list, and the sync write gate. Mobile upload flow (`media/uploadCore.ts`) already carries arbitrary `entityType`/`entityId` — no mobile pipeline change.

### Payer config list

`app_config` key `gas_receipt_payers`, value = JSON array of strings, on the `hidden_fields` pattern (`apps/mobile/src/db/queries/hiddenFields.ts`): module reactive cache with `useSyncExternalStore` (version counter + listeners + notify called after settings writes AND after sync pull). Default `['Teams','Office','Contents','Construction']` supplied **in code when the key is absent** — no seeded row, avoiding the migration-seed watermark trap. Settings editing UI is a later phase; this phase ships the query/subscribe module only.

### Sync wiring (per `docs/SYNC-MIGRATION-CHECKLIST.md`)

- `syncPolicy.ts`: `VEHICLES_COLS` (+4 columns), `VEHICLE_SERVICE_RECORDS_BASE` (+`payer`, `job_id`). `payer`/`job_id` are NOT financial-gated; `cost` stays gated.
- `apps/mobile/src/sync/pull.ts`: vehicles `TABLE_UPSERT_SQL` 10→14 columns; `rowToValues` maps `debris_option`/`open_checkout` → 0/1, `debris_level` default 0, `locked_by` passthrough; service records +2 columns.
- `pullColumns.test.ts`: new assertions for the added columns (this is the guard against partial wiring).
- `queries/vehicles.ts`: `VehicleRow` type + upsert paths gain the new columns; service-record insert path gains `payer`/`job_id`.
- No new tables → `ALLOWED_TABLES` / `FULL_TABLES` / `CONFLICT_TARGETS` in `routes/sync.ts` unchanged.

### locked_by write plumbing (the one behavior slice in this phase)

When `checkout_locked` flips true, stamp `locked_by = acting userId`; when it flips false, clear to NULL. Touch points: `upsertVehicleState` (`queries/vehicles.ts:108`) and its two callers (`VehicleEditSheet.tsx:103`, `VehiclePanel.tsx:282`). Without this, no hierarchy data accumulates before #167's UI phase. The unlock **rule** — `canManageVehicle AND (own tier >= locker's tier OR self-lock)`, tiers via `ROLE_TIER`/`effectiveTier` — is the follow-up phase, not this one. Server-side: vehicles push stays unrestricted (as today); enforcement remains client-side, consistent with #165.

## Out of scope (follow-up phases per item)

- #152 debris drag-to-fill control + conditional tank display (no truck mount → hide tanks).
- #155 checkout-list filtering by `open_checkout` + owner opt-in UI.
- #167 unlock-rule enforcement + lock pill "locked by X" display.
- #168 gas-receipt capture form (photo, payer picker, vehicle default + override logging via activity_log note, mileage, optional job) and the settings editor for `gas_receipt_payers`.

## Testing

- API: source-text invariants in `migrationSql.test.ts` idiom (no live PG in CI) — new columns present, no `CREATE TYPE`, no `DROP COLUMN`; syncPolicy column-list tests.
- Mobile: sql.js migration tests (existing harness), `pullColumns.test.ts` arity/column assertions, unit tests for the payer-config module and `locked_by` stamping in `upsertVehicleState`.
- Gate: full API + mobile suites, `tsc --noEmit` both sides, then dev-APK hotload + on-device sanity per CLAUDE.md.

## Deploy

API deploy auto-applies 065/066 on boot; ship API and mobile bundle in lockstep. Old APKs writing vehicles rows without the new columns are safe (defaults fill in). `open_checkout=false` default means owned vehicles drop out of other users' checkout list on deploy day — expected behavior, communicate to the crew.
