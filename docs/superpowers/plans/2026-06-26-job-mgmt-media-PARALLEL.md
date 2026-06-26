# Job Management + Universal Media — Parallel Implementation Plan

> **Execution model:** a small **sequential Foundation** builds the shared interfaces, then a **parallel fan-out** of agents each OWN a distinct set of files (no two agents touch the same file). Every agent is handed the **Shared Context Pack** below verbatim. Per-task: `tsc --noEmit` gate + curl e2e (data) / on-device (UI) + independent review, same as prior phases. No jest.

**Goal:** Job management (detail screen, edit, soft-delete/archive, crew-can't-create-jobs) + media (photos/video) on **every** entity, with a primary-photo thumbnail in lists.

**Decisions (locked):** soft-delete everywhere (jobs→`archived`, items/locations→`active=0`); media on items (done), jobs, locations, check-out/in, + list thumbnails; **set up the prod `s3.plexcontrol.com` proxy now** so media works on the standalone APK.

---

## ⭐ SHARED CONTEXT PACK — every agent MUST read this first

This is the single source of truth for fields, functions, and conventions. Do not deviate; if something here is wrong, flag it rather than working around it.

### Architecture invariants
- **Offline-first:** the app reads **local SQLite only** and never calls REST GET. Every write = a local query helper **+** `appendOutbox(op, table, payload)`. The server REST routes exist but the app does not consume them for reads.
- **op-sqlite binding:** `executeSync` binds only `string | number | null | ArrayBuffer`. Use `bindParams([...])` (from `../schema`) for any insert/update. Store booleans **locally as 0/1**; send **real booleans** to the outbox (Postgres columns are BOOLEAN).
- **Outbox rule:** `appendOutbox('INSERT', table, fullRowWithoutSyncedAt)` is a **full upsert keyed by the table's PK** (server `applyEntry`). Use `'INSERT'` for create AND update of a row you hold fully (stock, equipment_units, media). For `stock_by_location` send the **absolute post-adjust quantity** (via `getStockQuantity`), never a delta. Composite-key tables: `stock_by_location`=(item_id,location_id), `team_members`=(team_id,user_id), `role_settings`=(role); everything else keys by `id`.
- **Logging:** `appendLog(entry)` (in `src/db/queries/log.ts`) **self-enqueues** its own `activity_log` outbox row — call it once; NEVER also `appendOutbox('INSERT','activity_log',...)`. Shape: `{ user_id, team_id, action, entity_type, entity_id, from_location_id, to_location_id, quantity, unit, job_id, note, metadata, device_id }` (id/created_at generated inside). For unit moves the note is `'unit '+asset_tag`.
- **Sync allowlists:** a syncable table must be in BOTH `ALLOWED_TABLES` (push) and `FULL_TABLES` (full/pull) in `apps/api/src/routes/sync.ts`, AND have a template + `rowToValues` case in `apps/mobile/src/sync/pull.ts`. `media` and `jobs` are already wired.
- **Permissions:** gate UI with `usePermission('<perm>')` (hook) / `<PermissionGate permission="...">`. Relevant perms: `create_jobs`, `close_jobs`, `manage_locations`, `manage_users`, `upload_media`, `view_all_logs`, `manage_roles_permissions`, `add_inventory`, `edit_inventory`. `ROLE_DEFAULTS` (in `src/constants/roles.ts`) already sets tier-1 crew `create_jobs=false`.
- **Soft-delete pattern:** jobs → `status='archived'`; items → `active=0`; locations → `active=0` (column added in Foundation F1). Active lists filter out archived/inactive. Nothing is hard-deleted (the append-only `activity_log` RULES break FK integrity on real DELETE — documented gotcha).
- **Compile gate:** `cd ~/inventorypro/apps/mobile && npx tsc --noEmit -p tsconfig.json` and `cd ~/inventorypro/apps/api && npx tsc --noEmit`, both exit 0. No jest exists.
- **Dev stack:** `cd ~/inventorypro/infra && sg docker -c "docker compose up -d --build api"` (runs Postgres migrations). Postgres: `sg docker -c "docker exec infra-postgres-1 psql -U inventorypro -d inventorypro -tAc \"<SQL>\""`. Admin Alex Admin / PIN 12345678. Commit author: `-c user.name='InventoryPro Dev' -c user.email='matt@mattinfo.com'`; end bodies with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

### Key schema (current)
- `jobs(id, name, status['open'|'closed'|'archived'], created_by, created_at, updated_at)`.
- `inventory_items(id, name, barcode, description, sku, supplier, model, kind['product'|'equipment'], category, returnable(0/1), unit_tracked(0/1), tag_prefix, unit_category, unit, min_qty_alert, reorder_to, active(0/1), updated_at)`.
- `equipment_units(id, item_id, asset_tag, serial_number, status['available'|'deployed'|'in_repair'|'retired'], current_location_id, current_job_id, notes, created_at, updated_at)`.
- `stock_by_location(item_id, location_id, quantity, updated_at)` — count-based items only (unit-tracked derive on-hand from units).
- `locations(id, name, parent_id, color, icon, owner_user_id, updated_at)` — **gains `active(0/1)` in F1**.
- `media(id, entity_type, entity_id, media_type['image'|'video'], url, thumbnail_url, caption, is_primary(0/1), uploaded_by, created_at)` — generic; `entity_type` is a free string (`'item'|'job'|'location'|'checkin'|...`).
- `activity_log(... action, entity_type, entity_id, from_location_id, to_location_id, quantity, unit, job_id, note, metadata, created_at)` — append-only.

### Key existing functions (use these; don't reinvent)
- **jobs** (`src/db/queries/jobs.ts`): `getOpenJobs()`, `searchJobs(q)`, `getJobById(id)`, `upsertJob(job)`, `getActiveCheckoutsForUser(userId)` (filters `action='checkout_to_job' AND entity_type='item' AND i.unit_tracked=0`). **F2 adds:** `getAllJobs(includeArchived)`, `archiveJob(id)`, `updateJobFields(id,{name?,status?})`, `getJobDeployments(jobId)` (deployed equipment_units + count-based items out, from activity_log/units).
- **items** (`src/db/queries/items.ts`): `searchItems(q,limit,offset,category?)`, `getItemById`, `getStockByItem`, `adjustStock(itemId,locId,delta)`, `getStockQuantity`, `getDistinctValues('supplier'|'model'|'unit'|'category')`, `getLowStockItems()`. on-hand is unit-aware.
- **equipmentUnits** (`src/db/queries/equipmentUnits.ts`): `getUnitsForItem`, `getAvailableUnitsAtLocation`, `getUnitByTag`, `getDeployedUnitsForUser`, `countUnitsByStatus`, `setUnitStatus`, `upsertUnit`.
- **locations** (`src/db/queries/locations.ts`): `getAllLocations`, `getLocationTree`, `getTopLevelLocations`, `getSubAreas`, `getLocationById`, `getLocationsByOwner`, `upsertLocation`.
- **media:** `MediaGallery` component (`src/components/MediaGallery.tsx`, props `{entityType, entityId, canUpload?}`) does the whole upload flow (`getValidJwt()` → `POST /media/upload-url` → `PUT` with the returned `contentType` → local `media` insert + `appendOutbox('INSERT','media',...)` + first-photo→`is_primary`). **F3 adds:** a `src/db/queries/media.ts` module (`getMediaForEntity`, `getPrimaryMedia(entityType,entityId)`) + a `MediaThumbnail` component for lists.
- **auth/session:** `useSession()`→`{user}`, `usePermission(perm)`, `getValidJwt()`.
- **utils:** `generateUUID()`, `appendOutbox`, `appendLog`, `SearchablePicker`, `BarcodeInput`, `SuggestInput`, `UnitRow`.

### Server media (already complete)
`apps/api/src/routes/media.ts`: `POST /media/upload-url` (returns `{uploadUrl, key, publicUrl, contentType}` — client PUTs with that exact `contentType`), `POST /media` (save), `GET /media/:entityType/:entityId`, `DELETE /media/:id`. Two S3 clients: internal `s3` + `s3Public` (signs device-facing URLs against `MINIO_PUBLIC_ENDPOINT`). Prod env already set: `MINIO_PUBLIC_ENDPOINT=https://s3.plexcontrol.com`, `PUBLIC_MEDIA_URL=https://s3.plexcontrol.com/inventorypro-media`.

### 🔒 FILE OWNERSHIP MAP (prevents parallel collisions)
| File | Owner |
|---|---|
| `src/db/migrations/007_*` + sync/items/locations query additions | **F1/F2/F3** (foundation, sequential) |
| `apps/api/src/routes/jobs.ts` | **F2** |
| `src/components/media.ts` query + `MediaThumbnail.tsx` | **F3** |
| `app/(app)/(jobs)/[id].tsx` + `(jobs)/index.tsx` | **P1** (job detail+list, incl. its MediaGallery) |
| `app/(app)/(locations)/[id].tsx` (new) + `(locations)/index.tsx` | **P2** (location detail+tree, incl. its MediaGallery + thumbnails) |
| `app/(app)/(inventory)/index.tsx` (list thumbnails) | **P3** |
| `app/(app)/(checkout)/index.tsx` + `(checkin)/index.tsx` | **P4** (movement media + crew-create-jobs gate) |
No file appears in two rows → P1–P4 run concurrently safely.

---

## Phase 0 — Prerequisite (parallel with Foundation; partly user-side)
- [ ] **0a (user): prod `s3.plexcontrol.com` NPM proxy.** In NPM add a Proxy Host: `s3.plexcontrol.com` → `http`://`<unraid-ip>`:`9000`; SSL (Let's Encrypt + Force SSL); Advanced → Custom Nginx: `client_max_body_size 100m;` `proxy_set_header Host $host;` `proxy_set_header X-Real-IP $remote_addr;`. (See `~/nginx.conf.txt`.) Confirm the `inventorypro-media` bucket exists on prod MinIO (the prod `minio-init` creates it).
- [ ] **0b: verify** — after 0a, `curl -s -o /dev/null -w "%{http_code}" https://s3.plexcontrol.com/minio/health/live` (expect 200) and an end-to-end upload smoke test from a JWT (mirror the dev test in the media notes).

## Phase 1 — FOUNDATION (sequential; one agent or three quick serial agents). Produces the interfaces P1–P4 consume.

### F1 — Migration 007: `locations.active` (soft-delete) + dev/prod apply
- Postgres `007_location_active.sql`: `ALTER TABLE locations ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;`
- op-sqlite `007_location_active.ts` (version 7): `ALTER TABLE locations ADD COLUMN active INTEGER NOT NULL DEFAULT 1`; register in `loadMigrations()`.
- `Location` interface + `upsertLocation` + pull `locations` template/rowToValues gain `active` (0/1 local, boolean to outbox). Location read queries (`getAllLocations`, `getLocationTree`, `getTopLevelLocations`) filter `active = 1`.
- Gate: tsc both apps. e2e: push a `locations` row with `active:false`, confirm; rebuild api applies it.

### F2 — Jobs backend + queries (soft-delete, edit, detail aggregation)
- `apps/api/src/routes/jobs.ts`: list GET excludes `status='archived'` unless `?includeArchived=true`; the existing PATCH already updates `status`/`name` (archive = PATCH status='archived'); add nothing destructive. Add a `GET /jobs/:id/deployments` (optional) OR keep aggregation client-side.
- `src/db/queries/jobs.ts`: add `getAllJobs(includeArchived=false)`, `archiveJob(id)` (local UPDATE status='archived' + `appendOutbox('UPDATE','jobs',{id,status:'archived',updated_at})`), `updateJobFields(id,{name?,status?})` (+ outbox UPDATE), `getJobDeployments(jobId)` → `{ units: EquipmentUnit[] (status='deployed' AND current_job_id=jobId, join item name), countItems: rows from activity_log where job_id=jobId and action='checkout_to_job' and the item is non-unit-tracked }`.
- Gate: tsc both. e2e: archive a job via /sync/push UPDATE, confirm it's hidden from the non-archived list.

### F3 — Media foundation: query module + thumbnail component
- `src/db/queries/media.ts`: `getMediaForEntity(entityType,entityId): MediaRecord[]` (move the helper out of MediaGallery and import it back there), `getPrimaryMedia(entityType,entityId): MediaRecord | null` (`WHERE ... ORDER BY is_primary DESC, created_at DESC LIMIT 1`). Refactor `MediaGallery` to import `getMediaForEntity` from here (no behavior change).
- `src/components/MediaThumbnail.tsx`: small square `<Image>` of `getPrimaryMedia(...)?.thumbnail_url ?? url`, with a neutral placeholder (icon) when none. Props `{ entityType, entityId, size? }`.
- Gate: tsc. (UI verified when consumed.)

## Phase 2 — PARALLEL FAN-OUT (dispatch P1–P4 concurrently; each owns its files per the map). Each consumes F1–F3 interfaces + the Context Pack.

### P1 — Job detail screen + jobs list
Files: `app/(app)/(jobs)/[id].tsx` (from stub), `app/(app)/(jobs)/index.tsx`.
- Detail: job name + status badge; **deployed equipment units** + **items out** (via `getJobDeployments`); **activity** for the job (`activity_log WHERE job_id=?` — add `getLogForJob` if missing, it exists per earlier notes); **edit** (rename + status open/closed/archived, perm `create_jobs`/`close_jobs`) via `updateJobFields`; **Archive** button (perm `create_jobs`) via `archiveJob` with confirm; and a **`<MediaGallery entityType="job" entityId={id} canUpload={usePermission('upload_media')} />`** section.
- List: status filter chips (open/closed/all), an "show archived" toggle (`getAllJobs(true)`), tap → detail.
- Gate: tsc + on-device.

### P2 — Location detail screen + tree thumbnails + soft-delete
Files: `app/(app)/(locations)/[id].tsx` (NEW), `app/(app)/(locations)/index.tsx`.
- New detail: location name/owner; **stock at this location** (count-based items via a `getStockAtLocation(locId)` helper — add to locations or items queries if missing; for unit-tracked, available units at the location); **`<MediaGallery entityType="location" entityId={id} />`**; **Archive** (perm `manage_locations`) → set `active=0` + outbox.
- Tree (index): each location row shows a small `<MediaThumbnail entityType="location" entityId={loc.id} />`; tapping a location opens the detail screen (currently the tree only expands — add navigation to `[id]`). Keep the create modal + owner picker intact.
- Gate: tsc + on-device.

### P3 — Inventory list primary thumbnails
Files: `app/(app)/(inventory)/index.tsx` (and `ItemCard` if used).
- Each item row in the browse/search list shows `<MediaThumbnail entityType="item" entityId={item.id} />` (the item's primary photo, placeholder if none) — "if only the thumbnail picture for stock it should have a picture."
- Gate: tsc + on-device.

### P4 — Movement media + crew-can't-create-jobs gate
Files: `app/(app)/(checkout)/index.tsx`, `app/(app)/(checkin)/index.tsx`.
- **Crew gate:** in checkout's To-Job destination, only offer inline job creation (`SearchablePicker` `onCreate`) when `usePermission('create_jobs')`; otherwise the picker is select-only (crew picks an existing job, can't create). (Role defaults already block tier-1; this closes the UI gap.)
- **Movement media:** on the checkout and checkin confirm screens, allow attaching a photo to the event — `<MediaGallery entityType="checkin" entityId={<generated event id>} canUpload />` (or a lightweight "add photo" that uploads with `entity_type='checkout'|'checkin'`, `entity_id` = the activity_log id of the move). Keep it optional and out of the critical write path (media failure must not block the stock move).
- Gate: tsc + on-device.

## Phase 3 — Integration review + deploy
- [ ] Whole-branch review (most-capable model): path isolation (media never blocks moves; soft-delete consistent), sync integrity (media/jobs/locations active), permission gating, no file collisions across P1–P4, RN list keys.
- [ ] Fix wave for any Critical/Important.
- [ ] Apply migration 007 to dev + prod (rebuild image → ship via `unraid` skill → recreate). Merge to `main`.
- [ ] Rebuild the standalone APK (local, prod URL) so on-the-go media + jobs work; reinstall.

## Parallelization summary
- **Foundation (F1→F2→F3)** is sequential-ish (F1 migration first; F2/F3 can overlap once F1's interfaces are committed) — small, fast, creates shared interfaces.
- **P1, P2, P3, P4** dispatch **concurrently** (distinct files per the ownership map), each reviewed independently as it returns.
- Phase 0 (prod s3 proxy) runs in parallel with Foundation; media end-to-end testing waits on it.
