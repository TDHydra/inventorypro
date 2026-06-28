# P6 · Data & Sync Hardening — Implementation Plan

> Ultramode/SDD. Gate per task: `npx tsc --noEmit` clean (mobile + api). Implementers do NO git/tsc.

**Goal:** job external reference #; surface checkout/checkin move-photos; **delta-based, idempotent,
clamped** server stock merge; equipment_units synced_at parity audit. One migration (013); no native deps.
**Full spec:** `docs/superpowers/specs/2026-06-27-p6-hardening-design.md` — ships with every brief.

## Global Constraints
- Expo SDK 56; op-sqlite binds `string|number|null|ArrayBuffer`. **Migration 013; no native, no new permission.**
- Sync-migration checklist: `jobs` already synced → only mobile `pull.ts` jobs parity (008-class trap) + the
  new `ADJUST` handling in server `applyEntry`. `processed_outbox` is server-only (not synced).
- Outbox: real booleans, STRIP `synced_at`. Preserve `isWriteBlocked()` write-guards + `<MaintenanceBanner/>`.
- Per-entry push (no shared txn); `entry.id` = outbox UUID; `activity_log` already idempotent (pattern to mirror).

---

# WAVE 0 (foundation)

### Task 1: Migration 013
**Files:** `apps/api/src/db/migrations/013_hardening.sql`, `apps/mobile/src/db/migrations/013_hardening.ts`,
register version 13 in `apps/mobile/src/db/schema.ts`.
- api: `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS reference_number TEXT;`
  `CREATE TABLE IF NOT EXISTS processed_outbox (entry_id UUID PRIMARY KEY, processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`
  `CREATE INDEX IF NOT EXISTS processed_outbox_processed_at_idx ON processed_outbox(processed_at);`
- mobile: `ALTER TABLE jobs ADD COLUMN reference_number TEXT;` (no processed_outbox — server-only). Mirror an
  existing `{version, up(db)}` migration; register version 13.
- [ ] Controller: api+mobile tsc clean; commit `feat(db): migration 013 — job reference_number + processed_outbox`.

# WAVE 1 (parallel after Wave 0; file-disjoint)

### Task 2: Job reference # (UI + sync parity)
**Files:** `app/(app)/(jobs)/create.tsx`, `app/(app)/(jobs)/[id].tsx`, `apps/mobile/src/sync/pull.ts`.
- **pull.ts:** append `reference_number` to the `jobs` INSERT OR REPLACE (13 cols / 13 placeholders) and its
  `rowToValues` (`row.reference_number ?? null`). Verify exact parity.
- **create.tsx / [id].tsx:** advanced field "Reference # (external)" (separate from `job_number`); include
  `reference_number` in the job outbox payload (INSERT create / UPDATE edit); show on detail when set. Preserve
  maintenance guards + outbox conventions.
- [ ] Controller: mobile tsc clean; commit `feat(jobs): external reference number field + sync parity`.

### Task 3: Delta-based stock merge (core)
**Files:** `apps/mobile/src/sync/outbox.ts`, `apps/api/src/routes/sync.ts`, `app/(app)/(checkout)/index.tsx`,
`app/(app)/(checkin)/index.tsx`, `src/components/quickadd/StockQuickAdd.tsx`, `src/components/MoveStockModal.tsx`.
- **outbox.ts:** `OutboxOperation = 'INSERT'|'UPDATE'|'DELETE'|'ADJUST'`.
- **Writers → ADJUST:** replace each `appendOutbox('INSERT'|'UPDATE','stock_by_location',{...,quantity:abs})`
  with `appendOutbox('ADJUST','stock_by_location',{ item_id, location_id, delta, updated_at })` using the signed
  movement already passed to `adjustStock`: checkout `stockMove` (−qty / +qty), checkin (+returnQty),
  StockQuickAdd (+parsedQty), MoveStockModal (−n / +n). Keep the local `adjustStock(delta)` calls. Do NOT touch
  `(inventory)/add.tsx` (initial absolute).
- **Server `applyEntry`:** add `operation==='ADJUST' && table_name==='stock_by_location'` branch — the atomic
  idempotent+clamped CTE from the spec (params `[entry.id, item_id, location_id, delta]`, `updated_at = NOW()`).
  Reject as conflict if delta/item_id/location_id missing. ALSO clamp absolute `stock_by_location` INSERT/UPDATE
  with `GREATEST(0, …)`. On API boot, prune `processed_outbox` older than 7 days.
- [ ] Controller: mobile+api tsc clean; commit `feat(sync): delta-based stock merge (idempotent + clamped)`.

### Task 4: Move-photos in ActivityFeed
**Files:** `src/components/ActivityFeed.tsx` (+ `src/db/queries/media.ts` only if a batch helper is added).
- Per log entry, `getPrimaryMedia('activity_log', entry.id)`; if present, render a thumbnail; tap → full image
  (reuse existing image viewer / MediaGallery read view). Fetch for the visible page; add a batched
  `getMediaForEntities(entityType, ids[])` only if perf needs it.
- [ ] Controller: mobile tsc clean; commit `feat(activity): show checkout/checkin move-photos in feed`.

### Task 5: equipment_units synced_at parity audit
**Files:** none expected (verification).
- Confirm equipment_units outbox writers omit `synced_at`, Postgres table has no `synced_at`, and mobile pull
  upsert matches other tables. Fix minimally only if a real gap exists; otherwise report "parity confirmed".
- [ ] Controller: document outcome (commit only if a gap was fixed).

# SHIP (controller)
- [ ] App-wide tsc; whole-branch review (opus): migration 013 cross-platform; jobs pull.ts parity; ADJUST merge
  correctness (idempotency via processed_outbox keyed on entry.id; GREATEST(0,…) clamp; NOW() timestamp; dedup
  CTE skips on re-push); all 4 movement writers converted (no absolute stock pushes left except add.tsx);
  ActivityFeed media wiring; equipment_units audit. Merge → main, push. **Deploy:** migration 013 → API redeploy
  to Unraid required (run after merge; verify schema_migrations=13).

## Self-Review
- Spec coverage: U1→T1; U2→T2; U3→T3; U4→T4; U5→T5. ✔
- Collision: T1 migrations+schema.ts; T2 jobs/{create,[id]}+pull.ts; T3 outbox.ts+sync.ts+checkout+checkin+StockQuickAdd+MoveStockModal; T4 ActivityFeed(+media.ts). pull.ts only in T2; outbox.ts/sync.ts only in T3 → Wave-1 disjoint. ✔
- Risk: T3 idempotency — review must confirm a re-pushed entry.id applies the delta zero additional times, and
  that all movement writers (not add.tsx) switched to ADJUST.
