# Configurable Product Classes + Conditional Owner — Design Spec

*Date: 2026-06-27 · Branch: `feat/product-classes-owner` · P1 remainder, build #2 (after equipment split).*

## Context

Two P1 follow-ups on the now-products-only Inventory:

1. **Product class → curated units.** Today `inventory_items.unit_category` is a fixed enum
   (`liquid|piece|length|weight`) with hardcoded unit lists in `src/constants/units.ts`. Admins want to
   add/rename classes and edit each class's curated unit list in Manage Types — i.e. lift the existing
   measurement categories into the configurable `taxonomy_types` system (category `product_class`).
2. **Conditional Owner.** A parent location can be flagged "subareas require an owner"; when on, any child
   location (subarea) under it must have an owner assigned. Locations already carry `owner_user_id` and
   `parent_id` — this adds the per-parent gate.

### Decisions locked with the user
- **Class = the existing measurement category, made editable** (not a new product-type layer). One dimension,
  lifted into `taxonomy_types`.
- **Class stability under rename:** `inventory_items.unit_category` migrates from a string enum to a **stable
  taxonomy id** so renames don't orphan items. One-time remap via **4 fixed seed UUIDs** (identical on api +
  mobile).
- **Curated units stored in a single `meta TEXT` (JSON) column** on `taxonomy_types`, not a child table.
- **`formatQuantity` keeps its signature** `(qty, unit, classId)`, reading `allowDecimals` from a module-level
  cache — no call-site churn.
- **Owner rule = parent flag → children required.** Toggle `subareas_require_owner` on a parent; child save is
  blocked until an owner is picked. Unflagged parents leave owner optional.

## Global Constraints
- Expo SDK 56; op-sqlite binds `string|number|null|ArrayBuffer`. **One migration (012); no native deps, no new permission.**
- Synced-column changes follow `docs/SYNC-MIGRATION-CHECKLIST.md` (the 008-class trap: append new columns to
  mobile `pull.ts` `TABLE_UPSERT_SQL` + `rowToValues` with placeholder/value parity).
- `taxonomy_types` and `locations` are already in sync `ALLOWED_TABLES` / `FULL_TABLES` (conflict target `id`).
  API pull uses `SELECT *` for both and a generic payload-keyed upsert on push, so **no `sync.ts` list edits**
  are needed — only mobile `pull.ts` parity + outbox payloads carrying the new fields.
- TypeScript gate: `npx tsc --noEmit` clean (mobile + api) after every task.

## Shared Context Pack
- **Taxonomy (`src/db/queries/taxonomy.ts`):** `TaxonomyType {id,category,label,icon,sort_order,active,updated_at}`;
  `getTaxonomyTypes(category,{includeInactive})`, `addTaxonomyType`, `renameTaxonomyType`, `setTaxonomyIcon`,
  `setTaxonomyActive`, `reorderTaxonomyType`. All write via `INSERT OR REPLACE` + `appendOutbox('INSERT','taxonomy_types',{...})`
  with `active` as a **real boolean** and `synced_at` never included.
- **Units (`src/constants/units.ts`):** `UnitCategory` union, `UNIT_OPTIONS`, `UNIT_CATEGORY_LABELS`,
  `ALLOWS_DECIMALS`, `formatQuantity(qty,unit,category)`. Consumers: `inventory/add.tsx`, `inventory/[id].tsx`,
  `ItemCard.tsx`, `ItemQuickAdd.tsx`, `(jobs)/index.tsx`, `(checkin)/index.tsx`, `(checkout)/index.tsx`.
- **Items (`src/db/queries/items.ts`):** `searchItems(q,limit,offset,category?,kind?)`, `upsertItem`, `getItemById`.
  `inventory_items.unit_category` (TEXT) + `unit` (TEXT).
- **Locations:** `locations {id,name,parent_id,color,icon,owner_user_id,active,updated_at,latitude,longitude}`;
  add/edit at `app/(app)/(locations)/[id].tsx`, list at `index.tsx`. Owner picker pulls from users.
- **Manage Types screen:** `app/(app)/(admin)/manage-types.tsx` (tier-4), linked from `settings.tsx`.
- **Maintenance guard:** `useMaintenanceMode()→{locked}`, `isWriteBlocked()`, `<MaintenanceBanner/>`. Every write
  handler early-returns on `isWriteBlocked()`; buttons `disabled={locked}`.
- **Migrations:** mobile `src/db/migrations/NNN_*.ts` (`{version, up(db)}`, registered in `schema.ts`); api
  `src/db/migrations/NNN_*.sql`. Current max = **011**; this is **012**.

---

## Architecture (units)

### Unit 1 — Migration 012 (data model)
**Files:** `apps/api/src/db/migrations/012_product_classes_owner.sql`,
`apps/mobile/src/db/migrations/012_product_classes_owner.ts` (+ register in `schema.ts`).
- `ALTER TABLE taxonomy_types ADD COLUMN meta TEXT` (api: `TEXT`; mobile: `TEXT`). Nullable; JSON for
  `product_class` rows only.
- `ALTER TABLE locations ADD COLUMN subareas_require_owner` — api `BOOLEAN NOT NULL DEFAULT FALSE`,
  mobile `INTEGER NOT NULL DEFAULT 0`.
- **Seed 4 `product_class` rows** with **fixed UUIDs** (declared as shared constants used by BOTH migrations):
  | key (legacy value) | fixed UUID | label | meta.units | meta.allowDecimals |
  |---|---|---|---|---|
  | liquid | `00000000-0000-4000-8000-000000000c01` | Liquid | gallon,quart,pint,cup,fl oz,liter,ml | true |
  | piece  | `00000000-0000-4000-8000-000000000c02` | Pieces | each,pair,box,case,pack,set,roll | false |
  | length | `00000000-0000-4000-8000-000000000c03` | Length | ft,in,yd,m,cm | true |
  | weight | `00000000-0000-4000-8000-000000000c04` | Weight | lb,oz,kg,g | true |

  Seeds are idempotent (`WHERE NOT EXISTS`/`INSERT OR IGNORE` by id). `sort_order` 0–3, `active=1`.
- **Remap items:** `UPDATE inventory_items SET unit_category = '<fixed-uuid>' WHERE unit_category = '<legacy key>'`
  for each of the 4 (only rows still holding a legacy key; idempotent — re-running matches nothing).
- Applied identically server + client, so synced `unit_category` values converge.
- [ ] Controller: api+mobile tsc clean; commit `feat(db): migration 012 — product_class meta + subareas owner flag`.

### Unit 2 — Dynamic product classes (`src/constants/units.ts` + taxonomy helpers)
**Files:** `apps/mobile/src/constants/units.ts`, `apps/mobile/src/db/queries/taxonomy.ts`.
- `taxonomy.ts`: add `ProductClass = { id; label; icon; units: string[]; allowDecimals: boolean; active: number; sort_order: number }`;
  `getProductClasses(opts?): ProductClass[]` (parse `meta` JSON, default `{units:[],allowDecimals:true}` on null/parse-fail);
  `getProductClassById(id): ProductClass | null`; `setClassMeta(id, {units, allowDecimals})` — `INSERT OR REPLACE`
  preserving label/icon/sort_order/active, writes `meta=JSON.stringify(...)`, `appendOutbox('INSERT','taxonomy_types',{...,meta,active:bool})`
  (no `synced_at`). `addTaxonomyType` extended to accept optional `meta` so a new class can seed units at creation.
- `units.ts`: keep the legacy union/maps as a **fallback only**. Add a module-level cache
  `classDecimalsCache: Record<string,boolean>` + `loadClassConfigCache()` (reads `getProductClasses()`), called at
  app boot (where the DB is ready, e.g. the existing post-migration/sync hook) and after each sync.
  `formatQuantity(qty, unit, classId)` reads `classDecimalsCache[classId] ?? true` (signature unchanged → no
  call-site edits). Export `getUnitsForClass(classId)` thin wrapper over `getProductClassById`.
- [ ] Controller: mobile tsc clean; commit `feat(classes): dynamic product classes + decimals cache`.

### Unit 3 — Inventory consumers use dynamic classes
**Files:** `apps/mobile/app/(app)/(inventory)/add.tsx`, `apps/mobile/src/components/quickadd/ItemQuickAdd.tsx`,
`apps/mobile/app/(app)/(inventory)/index.tsx`, `apps/mobile/app/(app)/(inventory)/[id].tsx`.
- **add.tsx + ItemQuickAdd.tsx:** replace the hardcoded `UnitCategory`/`UNIT_OPTIONS` pickers with a **class
  picker** populated from `getProductClasses()` (label + optional icon), and a **unit dropdown** filtered to the
  selected class's `units`. Store `unit_category = selectedClass.id`. Default unit = first in the class's list;
  if the class has no curated units yet, allow free-text unit entry (graceful). Editing an existing item:
  resolve its current class via `getProductClassById(item.unit_category)`; if the id isn't a known class
  (legacy/unknown), show it selected by id and still allow re-pick.
- **index.tsx:** the `FilterCategory` chips (`'all'|'liquid'|'piece'|'length'|'weight'`) currently pass a raw
  enum to `searchItems(..., catFilter, 'product')` which compares `i.unit_category = ?`. After the remap that
  value is a class **id**. Make the chips **dynamic from `getProductClasses()`** — chip label = class label,
  filter value = class **id**, plus the existing "All". (`searchItems` already filters `unit_category = ?` —
  passing the id Just Works.)
- **[id].tsx:** the "Unit Type" row renders `UNIT_CATEGORY_LABELS[cat]`; after remap `cat` is an id → resolve
  via `getProductClassById(cat)?.label ?? cat`.
- Preserve maintenance guards, `synced_at` stripping, real-boolean outbox, AdvancedFields handling.
- [ ] Controller: mobile tsc clean; commit `feat(inventory): class+unit pickers + dynamic filter/label from taxonomy`.

### Unit 4 — Manage Types: Product Classes editor
**Files:** `apps/mobile/app/(app)/(admin)/manage-types.tsx` (extend).
- Add a **Product Classes** section (alongside Team/Job types): lists `getProductClasses({includeInactive:true})`
  with reuse of the existing add/rename/icon/active/reorder controls (category `product_class`).
- **Per-class units editor:** tap a class → editor showing its curated units as removable chips + an "add unit"
  text input; an **Allow decimals** toggle. Saving calls `setClassMeta(id,{units,allowDecimals})`. Guard with
  `isWriteBlocked()`; `<MaintenanceBanner/>`; controls `disabled={locked}`. After save, call
  `loadClassConfigCache()` so `formatQuantity` reflects the change immediately.
- New classes created here get `meta` seeded (empty units + allowDecimals=true) via the extended `addTaxonomyType`.
- [ ] Controller: mobile tsc clean; commit `feat(admin): product class units editor in Manage Types`.

### Unit 5 — Conditional Owner on locations
**Files:** `apps/mobile/app/(app)/(locations)/[id].tsx` (+ `src/db/queries/locations.ts` if a typed helper exists).
- Add a **"Subareas require an owner"** toggle bound to `subareas_require_owner` (shown when the location can
  have children — i.e. always, since any location may be a parent; place it in the location's settings area).
  Persist as real boolean in outbox; INTEGER locally.
- When the **current location's parent** has `subareas_require_owner = 1`, make the **Owner** field required:
  block save (disable confirm / show inline error) until `owner_user_id` is set. Look up the parent via
  `parent_id` → `getLocationById(parent_id)`. Unflagged/absent parent → owner optional (current behavior).
- Preserve maintenance guards + outbox conventions (real booleans, strip `synced_at`).
- [ ] Controller: mobile tsc clean; commit `feat(locations): per-parent subareas-require-owner gate`.

### Unit 6 — Sync parity
**Files:** `apps/mobile/src/sync/pull.ts`.
- `taxonomy_types`: append `meta` → `INSERT OR REPLACE INTO taxonomy_types (id,category,label,icon,sort_order,active,updated_at,meta) VALUES (?,?,?,?,?,?,?,?)` (8/8) and `rowToValues` `[...,, row.meta ?? null]`.
- `locations`: append `subareas_require_owner` → SQL 11 placeholders + `rowToValues` `[..., row.subareas_require_owner ? 1 : 0]`.
- Verify placeholder/value parity per the checklist. (API needs no edits — `SELECT *` + generic upsert.)
- [ ] Controller: mobile tsc clean; commit `feat(sync): taxonomy meta + location owner-flag pull parity`.

---

## File map
| Unit | Files |
|---|---|
| 1 | `apps/api/src/db/migrations/012_*.sql`, `apps/mobile/src/db/migrations/012_*.ts`, `apps/mobile/src/db/schema.ts` |
| 2 | `apps/mobile/src/constants/units.ts`, `apps/mobile/src/db/queries/taxonomy.ts` |
| 3 | `apps/mobile/app/(app)/(inventory)/add.tsx`, `apps/mobile/src/components/quickadd/ItemQuickAdd.tsx`, `apps/mobile/app/(app)/(inventory)/index.tsx`, `apps/mobile/app/(app)/(inventory)/[id].tsx` |
| 4 | `apps/mobile/app/(app)/(admin)/manage-types.tsx` |
| 5 | `apps/mobile/app/(app)/(locations)/[id].tsx` (+ `src/db/queries/locations.ts`) |
| 6 | `apps/mobile/src/sync/pull.ts` |

## Build order
Wave 0: Unit 1 (migration) → Unit 2 (dynamic classes/cache) — sequential foundation.
Wave 1 (parallel, file-disjoint after Wave 0): Unit 3 (inventory pickers), Unit 4 (Manage Types editor),
Unit 5 (locations owner), Unit 6 (sync parity).

## Verification
- `tsc --noEmit` clean (mobile + api).
- Migration 012 applies on a seeded DB: 4 `product_class` rows present with `meta`; existing items' `unit_category`
  remapped to the fixed UUIDs (no item shows a raw `liquid/piece/...` after migration); `locations.subareas_require_owner`
  defaults 0.
- Inventory add: class picker lists the 4 seeded classes; choosing a class filters the unit dropdown to its curated
  units; saved item stores `unit_category = classId`; quantities still format with correct decimals.
- Manage Types: add a class (e.g. "Filters"), give it units (each/pack/case) + decimals off → it appears in the
  inventory class picker; rename a class → existing items keep their class (id stable); edit a class's units →
  inventory picker reflects it.
- Locations: toggle "subareas require owner" on a parent → creating a child blocks save until an owner is set;
  parent without the flag → owner optional. Existing locations unaffected.
- Sync round-trip: a class meta edit + a location flag change push and pull back cleanly (boolean fidelity, no
  `synced_at` leakage, column parity).

## Out of scope (later)
- New product-type dimension on top of measurement (explicitly rejected — class IS the measurement category).
- Moving equipment back into inventory (equipment is its own system).
- Role/permission changes (P5), notifications (P3), location map/coords work (already shipped).
