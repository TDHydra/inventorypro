# Repair System (v1) — Design Spec

*Date: 2026-06-28 · Decisions locked with user (brainstorming).*

## Context
Crews need to track repairs as **tickets** with notes, parts needed, and a completion status — and the status list
must be admin-editable like job/item/location types. A repair can be about an **equipment unit**, a **general
item/asset**, or a **vehicle** (a location of type Vehicle). InventoryPro already has lightweight equipment
repair-out/in (a `equipment_units.status='in_repair'` flag + a note + `repair_out`/`repair_in` activity log) — the
new ticket system supersedes that for equipment by **auto-driving** the unit status.

## Decisions (locked)
- **Equipment link = auto-drive.** Opening a ticket on an equipment unit sets it `in_repair`; moving the ticket to a
  **terminal** status sets `completed_at` and returns the unit to `available` (prompt for the return location, reusing
  the existing repair-in location picker). Replaces the old repair-out/in note flow for equipment.
- **Completion = per-status "done" flag** stored in the `repair_status` taxonomy `meta` (`{terminal: true}`). Multiple
  end-states allowed (Repaired, Cannot Repair).
- **Parts needed = free-text** (a multi-line field), v1. (Catalog-linked parts is a later upgrade.)
- Out of scope v1 (revisit later): assignee, parts→stock deduction, cost tracking.

## Data model — migration (follows `docs/SYNC-MIGRATION-CHECKLIST.md`)
- **API `apps/api/src/db/migrations/021_repairs.sql`**: new table
  ```
  repairs(
    id UUID PRIMARY KEY,
    entity_type TEXT NOT NULL,        -- 'equipment_unit' | 'item' | 'location'
    entity_id   UUID NOT NULL,        -- no FK (sync-order safety)
    entity_label TEXT,                -- cached display (asset tag / item name / vehicle name)
    notes TEXT, parts_needed TEXT,
    status TEXT NOT NULL,             -- a repair_status label
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
  );
  ```
  Plus seed the `repair_status` taxonomy (idempotent by category+label, with `meta` JSON):
  Open `{terminal:false}` · Awaiting Parts `{false}` · In Progress `{false}` · Repaired `{terminal:true}` · Cannot Repair `{terminal:true}`.
- **Mobile `apps/mobile/src/db/migrations/019_repairs.ts`**: `CREATE TABLE IF NOT EXISTS repairs (... same cols, TEXT
  timestamps, + synced_at TEXT)`. Register `m019` in `schema.ts`.
- **Sync wiring**: add `'repairs'` to `ALLOWED_TABLES` + `FULL_TABLES` + `CONFLICT_TARGETS` n/a (keyed by `id`) in
  `apps/api/src/routes/sync.ts`; add a `repairs` `TABLE_UPSERT_SQL` + `rowToValues` case in `apps/mobile/src/sync/pull.ts`
  (keep col/placeholder parity). `repair_status` rows sync via the existing `taxonomy_types` path (data only).
- **Queries** `apps/mobile/src/db/queries/repairs.ts` (new): `Repair` interface; `getRepairs(filter?)`,
  `getRepairsForEntity(type,id)`, `getRepairById`, `createRepair`, `updateRepairStatus`, `updateRepairFields` — each
  pairs the local write with `appendOutbox('INSERT'|'UPDATE','repairs',…)` (strip `synced_at`), mirroring jobs/items.
- `repair_status` helpers in `taxonomy.ts`: `getRepairStatuses()`, `isTerminalStatus(label)` (reads meta.terminal).

## Behavior
- **Create**: "Report repair" on equipment-unit / item / vehicle detail → form (entity prefilled, `notes`,
  `parts_needed`, status picker default *Open*). On save: insert repair; if `entity_type='equipment_unit'` →
  `setUnitStatus(id,{status:'in_repair'})` + outbox; log `repair_opened`.
- **Status change** (repair detail): pick a `repair_status`. If the new status is terminal → set `completed_at`, log
  `repair_completed`, and (equipment) prompt return location → `setUnitStatus(id,{status:'available', location})`;
  else log `repair_status_changed`. Non-terminal→ just update.
- **Activity**: `repair_opened` / `repair_status_changed` / `repair_completed` to `activity_log` (entity_type 'repair').
- **Media** (optional, reuse): `MediaGallery entityType="repair"` on the detail screen.
- **Permission**: gate create/edit on the existing **`edit_inventory`** key (the same one equipment/inventory edit uses);
  viewing the Repairs list is ungated like the rest of the catalog.

## UI
- **Repairs list** (new top-level section/tab, PM-facing): all repairs; filter chips **Open / Done** + entity type;
  rows show entity_label + status badge + age. Tap → detail.
- **Repair detail**: entity (+ link to it), notes, parts needed, status picker, completed_at, MediaGallery, history feed.
- **Entry points**: "Report repair" button on equipment `[id]`, inventory item `[id]`, and vehicle (location `[id]` of
  type Vehicle) detail.
- **Manage Types**: a `repair_status` section (add/rename/icon/reorder/active) + a **"Counts as completed"** toggle in
  the edit modal for `repair_status` rows (writes `meta.terminal`; mirror the `allowDecimals` toggle + `setTaxonomyClassId`/
  `setTaxonomyUnits` meta-merge pattern → add a `setTaxonomyTerminal(id, bool)` helper).

## Build decomposition (ultramode — parallel after foundation)
- **Foundation (do first, sequential):** migration 021 (api) + 019 (mobile) + schema.ts + sync.ts allowlist + pull.ts
  wiring + `repairs.ts` queries + `repair_status` taxonomy helpers/seed. tsc + parity gate.
- **Agent A** — Repairs list + detail screens (`app/(app)/(repairs)/index.tsx`, `[id].tsx`) + the new route/tab.
- **Agent B** — entry points + create form + auto-drive equipment status (edits equipment `[id]`, inventory `[id]`,
  location `[id]`, a shared `repairs/new` or modal).
- **Agent C** — Manage Types `repair_status` section + "Counts as completed" toggle + `setTaxonomyTerminal` helper.
- Then: mobile tsc gate → adversarial review (sync wiring, auto-drive correctness, terminal-status handling).

## Verification
- tsc clean (mobile + api); pull.ts repairs parity; migration applies on prod; `repairs` table + `repair_status` seed present.
- E2E: report a repair on an equipment unit → unit shows `in_repair` + ticket in Repairs list (Open); set status →
  Repaired → unit returns to `available`, ticket completed_at set, shows under Done. Report on an item + a vehicle work.
  Add/rename a status + flip its "completed" toggle in Manage Types and see it drive completion. Sync round-trips a repair.

## Out of scope (later)
Assignee/owner of a repair; parts→stock deduction; cost; SLA/notifications. Equipment retains `retired` status separately.
