# P6 · Data & Sync Hardening — Design Spec

*Date: 2026-06-27 · Branch: `feat/p6-hardening` · Program P6 (after P1).*

## Context

A correctness/derisking bundle of four items on the existing sync layer:

1. **Job reference #** — a manual/external reference (insurance claim / customer PO), distinct from the
   existing internal `jobs.job_number`.
2. **equipment_units `synced_at` parity** — confirm `synced_at` handling matches other tables.
3. **Move-photos retrievable** — checkout/checkin photos already land in `media`
   (`entity_type='activity_log'`) but nothing renders them; surface them.
4. **Server-side stock re-validation** — stock pushes today send an **absolute** quantity and the server
   blindly overwrites, so concurrent edits race (last-write-wins drops a movement) and a bad value can throw
   the `quantity >= 0` CHECK and strand the outbox entry. Move to **delta-based** authoritative merge.

### Decisions locked with the user
- **Stock: delta-based merge** (not clamp-only). Movement writers push a delta; the server applies
  `quantity = GREATEST(0, quantity + delta)` authoritatively. Delta application is made **idempotent** (a
  retried push must not double-apply) via a server-side processed-entries table.
- Job reference # is a **separate** nullable field from `job_number`.
- equipment_units parity is an **audit-confirm** (expected: already correct — equipment writers already omit
  `synced_at` from outbox payloads and the Postgres table has no `synced_at`).
- Move-photos surfaced in the **`ActivityFeed`** component (one component backs job/equipment/activity views).

## Global Constraints
- Expo SDK 56; op-sqlite binds `string|number|null|ArrayBuffer`. **Migration 013; no native deps, no new permission.**
- Synced-column changes follow `docs/SYNC-MIGRATION-CHECKLIST.md`. `jobs` is already synced
  (`ALLOWED_TABLES`/`FULL_TABLES`, conflict `id`); API pull is `SELECT *` + generic push upsert → **no
  `sync.ts` table-list edits**; only mobile `pull.ts` jobs parity (the 008-class trap) + the new `ADJUST`
  handling in `applyEntry`.
- `processed_outbox` is **server-only** (not synced; not in any sync list).
- TypeScript gate: `npx tsc --noEmit` clean (mobile + api) after every task.

## Shared Context Pack
- **Sync push (`apps/api/src/routes/sync.ts`):** `applyEntry(pg, entry)` runs per-entry (no shared txn);
  switches on `operation`. `activity_log` is already idempotent via `WHERE NOT EXISTS`. Generic INSERT =
  full-row upsert `ON CONFLICT (key) DO UPDATE`; generic UPDATE = partial. `synced_at`/`__version` stripped.
  `entry.id` = the outbox entry UUID.
- **Outbox (`apps/mobile/src/sync/outbox.ts`):** `OutboxOperation = 'INSERT'|'UPDATE'|'DELETE'`;
  `appendOutbox(operation, table, payload)`. `synced_at` is only meaningful on the *outbox* table (drain marker);
  data-table `synced_at` is vestigial.
- **Stock (`apps/mobile/src/db/queries/items.ts`):** `adjustStock(itemId, locId, delta)` applies a clamped
  delta locally (`MAX(0, quantity + delta)`); `getStockQuantity`. Every current movement writer already calls
  `adjustStock(delta)` then pushes the read-back absolute — the delta is in hand at each call site.
- **Stock writers (push absolute today):** `(checkout)/index.tsx` `stockMove` (−qty source, +qty dest);
  `(checkin)/index.tsx` (+returnQty); `components/quickadd/StockQuickAdd.tsx` (+parsedQty);
  `components/MoveStockModal.tsx` (−n/+n). `(inventory)/add.tsx` writes the **initial** stock for a brand-new
  item (absolute — keep).
- **Jobs:** `jobs` mobile table has `job_number, customer_name, site_address, site_location_id, description, type`
  (12 cols in `pull.ts`). Writers: `(jobs)/create.tsx`, `(checkout)/index.tsx` (inline job create);
  edit/detail `(jobs)/[id].tsx`.
- **Media (`apps/mobile/src/db/queries/media.ts`):** `getMediaForEntity(entityType, entityId)`,
  `getPrimaryMedia(entityType, entityId)`. Feed: `src/components/ActivityFeed.tsx`.
- **Migrations:** mobile `src/db/migrations/NNN_*.ts` (`{version, up(db)}`, registered in `schema.ts`); api
  `src/db/migrations/NNN_*.sql`. Current max = **012**; this is **013**.

---

## Architecture (units)

### Unit 1 — Migration 013 (foundation)
**Files:** `apps/api/src/db/migrations/013_hardening.sql`, `apps/mobile/src/db/migrations/013_hardening.ts`
(+ register version 13 in `schema.ts`).
- api `.sql`:
  - `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS reference_number TEXT;`
  - `CREATE TABLE IF NOT EXISTS processed_outbox (entry_id UUID PRIMARY KEY, processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`
  - `CREATE INDEX IF NOT EXISTS processed_outbox_processed_at_idx ON processed_outbox(processed_at);`
- mobile `.ts`: `ALTER TABLE jobs ADD COLUMN reference_number TEXT;` (no `processed_outbox` — server-only).
- [ ] Controller: api+mobile tsc clean; commit `feat(db): migration 013 — job reference_number + processed_outbox`.

### Unit 2 — Job reference # (UI + sync parity)
**Files:** `app/(app)/(jobs)/create.tsx`, `app/(app)/(jobs)/[id].tsx`, `apps/mobile/src/sync/pull.ts`.
- **pull.ts:** append `reference_number` to the `jobs` `INSERT OR REPLACE` (13 cols / 13 placeholders) and
  `rowToValues` (`row.reference_number ?? null`). Verify parity (008-class trap).
- **create.tsx / [id].tsx:** an advanced field "Reference # (external)" (alongside `job_number`); include
  `reference_number` in the job outbox payload (INSERT on create, UPDATE on edit). Show it on job detail when set.
  Preserve maintenance guards + outbox conventions.
- [ ] Controller: mobile tsc clean; commit `feat(jobs): external reference number field + sync parity`.

### Unit 3 — Delta-based stock merge (the core)
**Files:** `apps/mobile/src/sync/outbox.ts`, `apps/api/src/routes/sync.ts`,
`app/(app)/(checkout)/index.tsx`, `app/(app)/(checkin)/index.tsx`,
`src/components/quickadd/StockQuickAdd.tsx`, `src/components/MoveStockModal.tsx`.
- **outbox.ts:** extend `OutboxOperation` to `'INSERT'|'UPDATE'|'DELETE'|'ADJUST'`.
- **Movement writers → ADJUST.** Replace each `appendOutbox('INSERT'|'UPDATE','stock_by_location',{...,quantity:abs})`
  with `appendOutbox('ADJUST','stock_by_location',{ item_id, location_id, delta, updated_at })` where `delta` is
  the signed movement already passed to `adjustStock`:
  - checkout `stockMove`: source `delta=-qty`, dest `delta=+qty`.
  - checkin: `delta=+returnQty`.
  - StockQuickAdd: `delta=+parsedQty`.
  - MoveStockModal: source `-n`, dest `+n`.
  Keep the local optimistic `adjustStock(delta)` calls unchanged (local clamps at 0; server truth overwrites on
  next pull). Do **not** change `(inventory)/add.tsx` (brand-new-row absolute initial stock).
- **Server `applyEntry`** (`sync.ts`):
  - New branch: `operation === 'ADJUST' && table_name === 'stock_by_location'` → one atomic, idempotent,
    clamped statement keyed by `entry.id`:
    ```sql
    WITH dedup AS (
      INSERT INTO processed_outbox (entry_id) VALUES ($1)
      ON CONFLICT (entry_id) DO NOTHING RETURNING entry_id)
    INSERT INTO stock_by_location (item_id, location_id, quantity, updated_at)
    SELECT $2, $3, GREATEST(0, $4), NOW() FROM dedup
    ON CONFLICT (item_id, location_id) DO UPDATE
      SET quantity = GREATEST(0, stock_by_location.quantity + $4),
          updated_at = NOW();
    ```
    Params: `[entry.id, item_id, location_id, delta]`. `updated_at = NOW()` (server clock) is authoritative for
    the merged row — a delta carrying an older client timestamp must not move `updated_at` backwards, or other
    devices' incremental pull (`WHERE updated_at > since`) would miss the change. A retried push (same `entry.id`)
    finds the dedup row already present → `dedup` empty → no stock change. Reject (conflict) if `delta`/`item_id`/
    `location_id` missing.
  - **Clamp absolute writes too:** for `stock_by_location` generic INSERT/UPDATE, clamp `quantity` with
    `GREATEST(0, …)` so a bad absolute can't throw the CHECK and strand the entry.
- **Prune:** on API boot, `DELETE FROM processed_outbox WHERE processed_at < NOW() - INTERVAL '7 days';`
  (dedup only needs the retry window). Add to the existing startup/migrate path.
- [ ] Controller: mobile+api tsc clean; commit `feat(sync): delta-based stock merge (idempotent + clamped)`.

### Unit 4 — Move-photos in ActivityFeed
**Files:** `src/components/ActivityFeed.tsx` (+ `src/db/queries/media.ts` only if a batch helper is added).
- For each log entry, look up `getPrimaryMedia('activity_log', entry.id)` (or `getMediaForEntity`); if present,
  render a thumbnail on the row; tap → open the full image (reuse the existing image viewer / `MediaGallery`
  read view). Keep the feed performant — fetch media for the visible page (per-entry `getPrimaryMedia` is fine;
  add a batched `getMediaForEntities(entityType, ids[])` only if needed).
- [ ] Controller: mobile tsc clean; commit `feat(activity): show checkout/checkin move-photos in feed`.

### Unit 5 — equipment_units `synced_at` parity audit
**Files:** none expected (verification task).
- Confirm: equipment_units outbox writers omit `synced_at` (they do — `(equipment)/[id].tsx`, `equipmentUnits.ts`);
  Postgres `equipment_units` has no `synced_at` (correct); mobile `pull.ts` upsert matches other tables. If any
  gap is found, fix it minimally and note it; otherwise document "parity confirmed, no change" in the commit/PR.
- [ ] Controller: document outcome (commit only if a real gap was found).

---

## File map
| Unit | Files |
|---|---|
| 1 | `apps/api/src/db/migrations/013_hardening.sql`, `apps/mobile/src/db/migrations/013_hardening.ts`, `apps/mobile/src/db/schema.ts` |
| 2 | `app/(app)/(jobs)/create.tsx`, `app/(app)/(jobs)/[id].tsx`, `apps/mobile/src/sync/pull.ts` |
| 3 | `apps/mobile/src/sync/outbox.ts`, `apps/api/src/routes/sync.ts`, `app/(app)/(checkout)/index.tsx`, `app/(app)/(checkin)/index.tsx`, `src/components/quickadd/StockQuickAdd.tsx`, `src/components/MoveStockModal.tsx` |
| 4 | `src/components/ActivityFeed.tsx` (+ `src/db/queries/media.ts` if batched) |
| 5 | (audit; none expected) |

## Build order
Wave 0: Unit 1 (migration). Wave 1 (parallel, file-disjoint): Unit 2 (job ref + pull.ts), Unit 3 (delta stock:
outbox.ts + server sync.ts + 4 writers), Unit 4 (ActivityFeed), Unit 5 (audit). No file overlaps: pull.ts only
in U2; outbox.ts/sync.ts only in U3; ActivityFeed/media only in U4.

## Verification
- `tsc --noEmit` clean (mobile + api).
- Migration 013 applies on a seeded DB: `jobs.reference_number` exists; `processed_outbox` exists (api).
- Job create/edit persists `reference_number`; it round-trips via sync and shows on detail.
- **Delta stock:** simulate two pushes of `delta=-3` from qty 10 with **different** `entry.id` → final 8
  (both applied). Re-push the **same** `entry.id` → no further change (idempotent). Push `delta=-100` from
  qty 5 → clamped to 0, entry not stranded. Absolute INSERT of a negative → clamped to 0.
- After a real checkout then checkin on a device, the location quantity returns to its starting value (deltas net to 0).
- `processed_outbox` prune runs on boot without error.
- Move-photos: a photo added during checkin shows as a thumbnail on that activity entry in the job/equipment/
  activity views; tap opens it.
- equipment_units: parity audit documented.

## Out of scope (later)
- A "set exact / recount" stock UI (would push an absolute set, not a delta — none exists today).
- Server-scheduled push notifications (P3).
- Multi-parent locations / map picker (P4); roles/teams (P5).
