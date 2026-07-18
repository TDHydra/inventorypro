# Configurable Product Classes + Conditional Owner — Implementation Plan

> Ultramode/SDD. Gate per task: `npx tsc --noEmit` clean (mobile + api). Implementers do NO git/tsc.

**Goal:** Lift `unit_category` into editable `taxonomy_types` (`product_class`) with curated units per class
(editable in Manage Types), migrating items to a **stable class id**; add a per-parent-location
"subareas require an owner" gate. One migration (012); no native deps.
**Full spec:** `docs/superpowers/specs/2026-06-27-product-classes-owner-design.md` — ships with every brief.

## Global Constraints
- Expo SDK 56; op-sqlite binds `string|number|null|ArrayBuffer`. **Migration 012; no native, no new permission.**
- Synced-column changes: follow `docs/SYNC-MIGRATION-CHECKLIST.md`. `taxonomy_types`/`locations` already in sync
  `ALLOWED_TABLES`/`FULL_TABLES` (target `id`); API pull is `SELECT *` + generic push upsert → **no `sync.ts`
  edits**; only mobile `pull.ts` parity + outbox payloads carry new fields.
- Outbox: real booleans (not 0/1), STRIP `synced_at`. Preserve `isWriteBlocked()` write-guards + `<MaintenanceBanner/>`.
- **Fixed seed UUIDs (shared by api + mobile migration):** liquid=`00000000-0000-4000-8000-000000000c01`,
  piece=`...c02`, length=`...c03`, weight=`...c04`.

---

# WAVE 0 (sequential foundation)

### Task 1: Migration 012
**Files:** `apps/api/src/db/migrations/012_product_classes_owner.sql`,
`apps/mobile/src/db/migrations/012_product_classes_owner.ts`, register in `apps/mobile/src/db/schema.ts`.
- `ALTER TABLE taxonomy_types ADD COLUMN meta TEXT` (both). `ALTER TABLE locations ADD COLUMN
  subareas_require_owner` (api `BOOLEAN NOT NULL DEFAULT FALSE`; mobile `INTEGER NOT NULL DEFAULT 0`).
- Seed 4 `product_class` rows by **fixed UUID** (idempotent): label Liquid/Pieces/Length/Weight, sort_order 0–3,
  active true, `meta=JSON` with `units` + `allowDecimals` from current `src/constants/units.ts`
  (`UNIT_OPTIONS`/`ALLOWS_DECIMALS`).
- Remap: `UPDATE inventory_items SET unit_category='<fixed-uuid>' WHERE unit_category='<legacy key>'` ×4 (idempotent).
- Mobile migration follows the existing `{version, up(db)}` shape; register version 12 in schema.ts.
- [ ] Controller: api+mobile tsc clean; commit `feat(db): migration 012 — product_class meta + subareas owner flag`.

### Task 2: Dynamic product classes + decimals cache
**Files:** `apps/mobile/src/db/queries/taxonomy.ts`, `apps/mobile/src/constants/units.ts`.
- `taxonomy.ts`: `ProductClass {id,label,icon,units:string[],allowDecimals:boolean,active:number,sort_order:number}`;
  `getProductClasses(opts?)` (parse `meta`, default `{units:[],allowDecimals:true}` on null/bad JSON);
  `getProductClassById(id)`; `setClassMeta(id,{units,allowDecimals})` (INSERT OR REPLACE preserving
  label/icon/sort_order/active; outbox `INSERT taxonomy_types` with `meta` + `active` real boolean, no `synced_at`).
  Extend `addTaxonomyType` to accept optional `meta`.
- `units.ts`: keep legacy maps as fallback; add `classDecimalsCache: Record<string,boolean>` +
  `loadClassConfigCache()` (from `getProductClasses()`), call at app boot + after sync. `formatQuantity(qty,unit,classId)`
  reads `classDecimalsCache[classId] ?? true` — **signature unchanged**. Add `getUnitsForClass(classId)`.
- [ ] Controller: mobile tsc clean; commit `feat(classes): dynamic product classes + decimals cache`.

# WAVE 1 (parallel after Wave 0; file-disjoint)

### Task 3: Inventory consumers use dynamic classes
**Files:** `app/(app)/(inventory)/add.tsx`, `src/components/quickadd/ItemQuickAdd.tsx`,
`app/(app)/(inventory)/index.tsx`, `app/(app)/(inventory)/[id].tsx`.
- **add.tsx + ItemQuickAdd:** class picker from `getProductClasses()` → unit dropdown filtered to class `units`;
  store `unit_category = classId`; default unit = first in list; free-text unit if class has none. Edit path:
  resolve current class via `getProductClassById(item.unit_category)`, tolerate unknown id.
- **index.tsx:** make `FilterCategory` chips dynamic from `getProductClasses()` — chip label = class label, filter
  value = class **id**, keep "All". (`searchItems(...,catFilter,'product')` already filters `unit_category=?`.)
- **[id].tsx:** "Unit Type" row → `getProductClassById(cat)?.label ?? cat` (replaces `UNIT_CATEGORY_LABELS[cat]`).
- Preserve maintenance guards, `synced_at` strip, real-boolean outbox, AdvancedFields.
- [ ] Controller: mobile tsc clean; commit `feat(inventory): class+unit pickers + dynamic filter/label from taxonomy`.

### Task 4: Manage Types — Product Classes editor
**Files:** `app/(app)/(admin)/manage-types.tsx`.
- Add a **Product Classes** section (category `product_class`) reusing existing add/rename/icon/active/reorder.
- Per-class **units editor**: removable unit chips + add-unit input + **Allow decimals** toggle → `setClassMeta`.
  Guard `isWriteBlocked()`; `<MaintenanceBanner/>`; controls `disabled={locked}`. After save call
  `loadClassConfigCache()`. New classes seed `meta` (empty units, allowDecimals true) via extended `addTaxonomyType`.
- [ ] Controller: mobile tsc clean; commit `feat(admin): product class units editor in Manage Types`.

### Task 5: Conditional Owner on locations
**Files:** `app/(app)/(locations)/[id].tsx` (+ `src/db/queries/locations.ts` if a typed helper exists).
- "Subareas require an owner" toggle → `subareas_require_owner` (real boolean outbox, INTEGER local).
- If the location's **parent** has `subareas_require_owner=1`, require `owner_user_id`: block save (disable
  confirm + inline error) until set. Resolve parent via `parent_id`→`getLocationById`. Unflagged/no parent → optional.
- Preserve maintenance guards + outbox conventions.
- [ ] Controller: mobile tsc clean; commit `feat(locations): per-parent subareas-require-owner gate`.

### Task 6: Sync parity (pull.ts)
**Files:** `apps/mobile/src/sync/pull.ts`.
- `taxonomy_types`: SQL → add `meta` (8 cols/8 placeholders); `rowToValues` append `row.meta ?? null`.
- `locations`: SQL → add `subareas_require_owner` (11/11); `rowToValues` append `row.subareas_require_owner ? 1 : 0`.
- Verify placeholder/value parity (checklist). API: no edits.
- [ ] Controller: mobile tsc clean; commit `feat(sync): taxonomy meta + location owner-flag pull parity`.

# SHIP (controller)
- [ ] App-wide tsc (mobile + api); whole-branch review (opus): migration remap correctness + fixed-UUID parity
  across api/mobile; no raw-enum `unit_category` consumer left (filter chips, labels, decimals); class id stable
  under rename; owner gate blocks child save only under a flagged parent; sync column parity (no `synced_at` leak,
  boolean fidelity). Merge → main, push. **Deploy:** migration 012 → API redeploy to Unraid required (run after merge).

## Self-Review
- Spec coverage: U1→T1; U2→T2; U3(add/quickadd/index/[id])→T3; U4→T4; U5→T5; U6→T6. ✔
- Collision: T3 inventory/{add,index,[id]}+ItemQuickAdd; T4 manage-types; T5 locations/[id]; T6 pull.ts; T2 taxonomy.ts+units.ts;
  T1 migrations+schema.ts. All Wave-1 file-disjoint; Wave-0 (T1,T2) sequential. ✔
- Risk: T1 remap must use the SAME fixed UUIDs on both platforms (declare as literals in each migration);
  final review verifies no consumer still keys on the legacy enum strings.
