# Repair System (v1) Implementation Plan

> **For agentic workers:** Executed via an **ultramode Workflow** — a sequential **Foundation** task first, then 3 **parallel** agents (A/B/C), then a tsc gate + adversarial review. This codebase has **no unit-test framework**; the verification gate for every task is `npx tsc --noEmit` (mobile + api) plus the e2e checks in each task. Steps use `- [ ]` checkboxes.

**Goal:** Repair tickets (notes, parts-needed, admin-configurable status) attaching to an equipment unit, a general item, or a vehicle (location of type Vehicle); completing a ticket auto-drives equipment status.

**Architecture:** New synced `repairs` table + a `repair_status` taxonomy (with a per-status `meta.terminal` flag). Mobile reads local SQLite and writes via the outbox (`appendOutbox('INSERT'|'UPDATE','repairs',…)`), exactly like jobs/items. Opening a ticket on an equipment unit sets it `in_repair`; a terminal status returns it to `available`.

**Tech Stack:** Expo SDK 56 / RN 0.85.3 / op-sqlite / expo-router (mobile); Fastify + Postgres (api). Spec: `docs/superpowers/specs/2026-06-28-repair-system-design.md`.

## Global Constraints (copied from spec — bind every task)
- **Sync-migration checklist** (`docs/SYNC-MIGRATION-CHECKLIST.md`): a new synced table needs `sync.ts` (`ALLOWED_TABLES` + `FULL_TABLES`; `CONFLICT_TARGETS` only if PK ≠ `id` — repairs is keyed by `id`, so none) **and** `pull.ts` (`TABLE_UPSERT_SQL` + `rowToValues`, **col/placeholder parity**) **and** the mobile migration + interface + queries.
- **No FK** on `repairs.entity_id` / `created_by` (sync-order safety, like `home_location_id`).
- **Outbox correctness**: strip the local-only `synced_at` from every payload; booleans as real booleans; never leak `synced_at`.
- **tsc gate**: `npx tsc --noEmit` clean in `apps/mobile` and `apps/api`.
- **Migration numbers**: API next = **021**; mobile next = **019**.
- **Permission**: gate create/edit on `edit_inventory`; viewing the list is ungated.
- **Reuse**: `taxonomy_types` + `getTaxonomyTypes`/`addTaxonomyType`/`setTaxonomyUnits`/`setTaxonomyClassId` patterns; `setUnitStatus` (`src/db/queries/equipmentUnits.ts`); `appendLog`; `FilterChip`/`SearchablePicker`/`ModalSheet`/`FieldLabel`/`AppInput`/`PrimaryButton`/`MediaGallery`; `getLocationTypes()`.

---

## Task 1 — Foundation (sequential, FIRST)

**Files:**
- Create: `apps/api/src/db/migrations/021_repairs.sql`
- Create: `apps/mobile/src/db/migrations/019_repairs.ts`
- Modify: `apps/mobile/src/db/schema.ts` (register `m019`)
- Modify: `apps/api/src/routes/sync.ts` (`ALLOWED_TABLES`, `FULL_TABLES` add `'repairs'`)
- Modify: `apps/mobile/src/sync/pull.ts` (`repairs` `TABLE_UPSERT_SQL` + `rowToValues` case)
- Create: `apps/mobile/src/db/queries/repairs.ts`
- Modify: `apps/mobile/src/db/queries/taxonomy.ts` (repair-status helpers)

**Produces (the contract A/B/C consume):**
```ts
// src/db/queries/repairs.ts
export interface Repair {
  id: string;
  entity_type: 'equipment_unit' | 'item' | 'location';
  entity_id: string;
  entity_label: string | null;
  notes: string | null;
  parts_needed: string | null;
  status: string;                 // a repair_status label
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  synced_at?: string | null;      // local-only
}
export function getRepairs(opts?: { done?: boolean; entityType?: string }): Repair[];
export function getRepairsForEntity(entityType: string, entityId: string): Repair[];
export function getRepairById(id: string): Repair | null;
// createRepair: inserts locally + appendOutbox('INSERT','repairs',…); returns the new Repair.
export function createRepair(input: {
  entity_type: Repair['entity_type']; entity_id: string; entity_label: string | null;
  notes: string | null; parts_needed: string | null; status: string; created_by: string | null;
}): Repair;
// updateRepairFields: partial notes/parts_needed/entity_label + outbox UPDATE. Returns updated_at.
export function updateRepairFields(id: string, fields: Partial<Pick<Repair,'notes'|'parts_needed'|'entity_label'>>): string;
// updateRepairStatus: set status (+ completed_at when terminal) + outbox UPDATE. Returns {updated_at, completed: boolean}.
export function updateRepairStatus(id: string, status: string, terminal: boolean): { updated_at: string; completed: boolean };

// src/db/queries/taxonomy.ts
export const REPAIR_STATUS = 'repair_status';
export function getRepairStatuses(opts?): TaxonomyType[];          // getTaxonomyTypes('repair_status', …)
export function isTerminalStatus(label: string): boolean;          // reads the row's meta.terminal
export function setTaxonomyTerminal(id: string, terminal: boolean): void;  // merge {terminal} into meta (+ outbox), like setTaxonomyClassId
```

- [ ] **Step 1 — API migration** `021_repairs.sql`: `CREATE TABLE IF NOT EXISTS repairs(id UUID PRIMARY KEY, entity_type TEXT NOT NULL, entity_id UUID NOT NULL, entity_label TEXT, notes TEXT, parts_needed TEXT, status TEXT NOT NULL, created_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ);` Then seed `repair_status` taxonomy (idempotent `INSERT … SELECT … WHERE NOT EXISTS`, mirroring migration 011/019), with `meta`: Open `{"terminal":false}` (sort 0), Awaiting Parts `{"terminal":false}` (1), In Progress `{"terminal":false}` (2), Repaired `{"terminal":true}` (3), Cannot Repair `{"terminal":true}` (4).
- [ ] **Step 2 — Mobile migration** `019_repairs.ts` (`version: 19`): `CREATE TABLE IF NOT EXISTS repairs (id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, entity_label TEXT, notes TEXT, parts_needed TEXT, status TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, synced_at TEXT)`. Register `m019` in `schema.ts` (import + append to the sorted array, mirroring `m018`).
- [ ] **Step 3 — sync.ts**: add `'repairs'` to `ALLOWED_TABLES` and `FULL_TABLES`. (PK is `id` → no `CONFLICT_TARGETS` entry. No `SELECT_COLUMNS` override.)
- [ ] **Step 4 — pull.ts**: add `repairs: \`INSERT OR REPLACE INTO repairs (id, entity_type, entity_id, entity_label, notes, parts_needed, status, created_by, created_at, updated_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)\`` and a `case 'repairs': return [row.id, row.entity_type, row.entity_id, row.entity_label ?? null, row.notes ?? null, row.parts_needed ?? null, row.status, row.created_by ?? null, row.created_at, row.updated_at, row.completed_at ?? null];` — **11 cols / 11 placeholders**.
- [ ] **Step 5 — repairs.ts queries**: implement the contract above. `createRepair` generates a uuid + ISO timestamps, `INSERT` locally, then `appendOutbox('INSERT','repairs', {…without synced_at})`. `updateRepairStatus` sets `status`, `updated_at=now`, and `completed_at = terminal ? now : null`; mirror that in the outbox UPDATE payload. Mirror `src/db/queries/jobs.ts` `updateJobFields` for the UPDATE shape.
- [ ] **Step 6 — taxonomy.ts**: add `REPAIR_STATUS`, `getRepairStatuses`, `isTerminalStatus` (find the row by label in `getTaxonomyTypes('repair_status',{includeInactive:true})`, `JSON.parse(meta).terminal === true`), and `setTaxonomyTerminal(id, terminal)` — copy `setTaxonomyClassId` but merge `{terminal}` into meta.
- [ ] **Step 7 — Gate**: `cd apps/mobile && npx tsc --noEmit` and `cd apps/api && npx tsc --noEmit` both clean; confirm pull.ts repairs parity (11/11). Commit `feat(repairs): foundation — table + sync + queries + status taxonomy`.

---

## Task A — Repairs list + detail screens *(parallel, after Foundation)*

**Files:** Create `apps/mobile/app/(app)/(repairs)/index.tsx`, `apps/mobile/app/(app)/(repairs)/[id].tsx`; add the route to the app navigation (mirror how `(equipment)` is registered — likely a dashboard tile/link + the stack).
**Consumes:** `getRepairs`, `getRepairById`, `updateRepairStatus`, `updateRepairFields`, `getRepairStatuses`, `isTerminalStatus`, `Repair` (Task 1); `MediaGallery`, `ActivityFeed`/`getLogForEntity`, `setUnitStatus` (for the completion return-location — see Task B's helper; if B's shared helper isn't importable, the detail screen calls `setUnitStatus` directly for equipment completion).

- [ ] **List** `(repairs)/index.tsx`: `Stack.Screen` title "Repairs". `FilterChip` row: **Open** (default) / **Done** / **All** + (optional) entity-type chips. Rows = `getRepairs({done})` → entity_label, a status badge, age (created_at), tap → `/(app)/(repairs)/[id]`. `EmptyState` when none. Reuse list styling from `(jobs)/index.tsx`.
- [ ] **Detail** `(repairs)/[id].tsx`: header (entity_label + entity_type + a link back to the entity's screen), editable `notes` + `parts_needed` (AppInput, save via `updateRepairFields`), a **status picker** (`FilterChip` row from `getRepairStatuses()`); selecting a status calls `updateRepairStatus(id, label, isTerminalStatus(label))` then, **if it became terminal AND entity_type==='equipment_unit'**, prompt a return-location (`SearchablePicker` of locations) and `setUnitStatus(entity_id, {status:'available', current_location_id})` + `appendOutbox('UPDATE','equipment_units',…)`; log `repair_completed`/`repair_status_changed` via `appendLog` (entity_type `'repair'`). `MediaGallery entityType="repair" entityId={id}`. History via `getLogForEntity('repair', id)`.
- [ ] **Gate**: mobile tsc clean. (Committed centrally after review.)

---

## Task B — Entry points + create form + auto-drive *(parallel, after Foundation)*

**Files:** Create `apps/mobile/app/(app)/(repairs)/new.tsx` (create form, reads `useLocalSearchParams<{entityType,entityId,entityLabel}>()`); Modify `apps/mobile/app/(app)/(equipment)/[id].tsx`, `apps/mobile/app/(app)/(inventory)/[id].tsx`, `apps/mobile/app/(app)/(locations)/[id].tsx` (add a **"Report repair"** button).
**Consumes:** `createRepair`, `getRepairStatuses`, `Repair` (Task 1); `setUnitStatus` (`equipmentUnits.ts`); `getLocationById`/`Location.type` (to gate the vehicle button); `usePermission('edit_inventory')`.

- [ ] **Create form** `(repairs)/new.tsx`: prefilled entity (from params, read-only display), `notes` + `parts_needed` AppInputs, a status `FilterChip` row (`getRepairStatuses()`, default the first non-terminal, usually *Open*). On Save (gated `edit_inventory`, `isWriteBlocked()` guard): `createRepair({entity_type, entity_id, entity_label, notes, parts_needed, status, created_by: user.id})`; **if entity_type==='equipment_unit'** → `setUnitStatus(entity_id,{status:'in_repair'})` + `appendOutbox('UPDATE','equipment_units',…)`; `appendLog('repair_opened', entity_type:'repair', entity_id:newRepair.id)`; navigate to `/(app)/(repairs)/[id]`.
- [ ] **Entry points**: on equipment `[id]` (entityType `equipment_unit`, entity_label = asset tag — per-unit, place on each unit row or the model header per the screen's structure), inventory item `[id]` (entityType `item`, label = item.name), and location `[id]` **only when `location.type === 'Vehicle'`** (entityType `location`, label = location.name): a "Report repair" button → `router.push({pathname:'/(app)/(repairs)/new', params:{entityType, entityId, entityLabel}})`. Gate on `usePermission('edit_inventory')`.
- [ ] **Gate**: mobile tsc clean.

---

## Task C — Manage Types: repair_status section + terminal toggle *(parallel, after Foundation)*

**Files:** Modify `apps/mobile/app/(app)/(admin)/manage-types.tsx`.
**Consumes:** `getTaxonomyTypes`, `setTaxonomyTerminal`, `parseItemTypeMeta`-style meta read (Task 1).

- [ ] Add `repair_status: 'Repair Status'` to `CATEGORY_NOUN`; add a `repairStatuses` state (`getTaxonomyTypes('repair_status',{includeInactive:true})`) loaded initially + in `refresh()`; add `renderSection('Repair Statuses','repair_status', repairStatuses, '+ Add Repair Status')` (mirror `location_type`).
- [ ] In the edit modal, when `editType.category === 'repair_status'`, show a **"Counts as completed"** `Switch` bound to a new `editTerminal` state (seeded in `openEdit` from `JSON.parse(item.meta||'{}').terminal === true`); on save, if changed, call `setTaxonomyTerminal(editType.id, editTerminal)` and include it in `editDirty`. No units editor for `repair_status`.
- [ ] **Gate**: mobile tsc clean.

---

## Verify + Review (Workflow tail)
- [ ] Agent: `cd apps/mobile && npx tsc --noEmit` + `cd apps/api && npx tsc --noEmit` → both clean; pull.ts repairs parity 11/11.
- [ ] Adversarial review (no edits): sync wiring complete (`repairs` in ALLOWED+FULL, pull parity, mobile migration registered); outbox payloads strip `synced_at`; **auto-drive correctness** — open→`in_repair`, terminal→`available` + `completed_at`, non-terminal stays; the vehicle button only shows for `type==='Vehicle'`; per-unit `equipment_label`/entity_id correct; no FK/sync-order issues. Report blocker/important/minor.
- [ ] Apply review fixes; central commit `feat(repairs): list/detail, entry points + auto-drive, manage-types status`.

## Post-merge (operational)
- [ ] Deploy API image (migration 021) to prod; verify `repairs` table + `repair_status` seed; health ok.
- [ ] Rebuild + install APK. E2E from the spec's Verification section.

## Self-review (done)
Spec coverage: data model (T1), status taxonomy + terminal (T1+C), list/detail (A), entry points + auto-drive (B),
Manage Types (C), permission/media/activity (A+B). No placeholders — interfaces + SQL + col counts given. Type
consistency: `Repair`, query signatures, `setTaxonomyTerminal`, `isTerminalStatus` referenced identically across tasks.
