# Equipment as Its Own System — Design Spec

*Date: 2026-06-27 · Branch: `feat/equipment-system` · P1 remainder, build #1 (before product class→units).*

## Context

Equipment is fundamentally different from consumable products: it's tracked per-unit (asset tag, serial,
status, location, job, repair history) and has **no unit-of-measure**. Today it's bolted onto the product
flow (`inventory_items.kind='equipment'` + the add-form toggle + ~221 equipment refs inside the 900-line
`inventory/[id].tsx`). This makes Equipment its **own tab/section**; Inventory then becomes products-only.

### Decisions locked with the user
- **Equipment is its own tab** (own list/detail/add), sharing locations, jobs, checkout/checkin.
- **Keep the data model** — equipment models stay as `inventory_items` (`kind='equipment'`); units stay in
  `equipment_units`. **No migration** — this is an IA/UI refactor, low-risk.
- **Photo per model** — equipment models get a primary photo via the SAME media system products use
  (`media`, `entity_type='item'`, `MediaGallery`/`MediaThumbnail`/`getPrimaryMedia`).
- Equipment list is **grouped by model → drill into units** (not a flat unit list).
- The product/equipment **toggle is removed** from the inventory add form (Inventory = products only).
- (Build #2, separate: product class→curated-units + conditional Owner — NOT in this spec.)

## Global Constraints
- Expo SDK 56; op-sqlite binds `string|number|null|ArrayBuffer`. **No migration, no native deps, no new permission.**
- Equipment models = `inventory_items WHERE kind='equipment'`; units = `equipment_units` (FK `item_id`).
- Reuse existing queries/components; do NOT duplicate logic — MOVE the equipment-unit UI out of `inventory/[id]`.
- TypeScript gate: `npx tsc --noEmit` clean (mobile + api). (API likely untouched.)

## Shared Context Pack
- **Route groups:** `app/(app)/(inventory|jobs|locations|teams|...)/`; nav via `router.push('/(app)/(x)')`; dashboard tiles in `(dashboard)/index.tsx`.
- **Equipment unit queries (`src/db/queries/equipmentUnits.ts`):** `getUnitsForItem(itemId)`, `getAvailableUnitsAtLocation`, `getUnitByTag`, `countUnitsByStatus(itemId)→{available,deployed,in_repair,retired}`, `getDeployedUnitsForUser`, `upsertUnit`, `setUnitStatus`. `nextAssetTag(prefix)` in `src/db/queries/equipment.ts`.
- **Item model queries (`src/db/queries/items.ts`):** `upsertItem`, `searchItems(q,limit,offset,catFilter)`, `getItemById`. Equipment models are items with `kind='equipment'`, `unit_tracked=1`, `tag_prefix`.
- **Media:** `MediaGallery entityType entityId canUpload` (full gallery+upload), `MediaThumbnail entityType entityId size` (list thumb), `getPrimaryMedia(entityType,entityId)`. Products use `entityType="item"`; units already use `entityType="equipment_unit"`.
- **Source to extract from:** `app/(app)/(inventory)/[id].tsx` (900 lines) holds the equipment-unit management: registered-units list, add-units modal (asset tag scan + nextAssetTag generate + serial), edit-unit, retire, repair in/out + history, per-unit media. `EquipmentQuickAdd` (`src/components/quickadd/`) + the `kind==='equipment'` path in `(inventory)/add.tsx` hold equipment creation.
- **UI primitives:** `ui/*` (PrimaryButton/AppInput/Card/ModalSheet/FieldLabel/EmptyState/LoadingView), `theme.ts`, `renderIcon`, `useMaintenanceMode`/`isWriteBlocked` (preserve write-guards), `useFormMode`/`AdvancedFields`.

---

## Architecture (units)

### Unit 1 — Equipment model query helpers (`src/db/queries/equipment.ts`, extend)
- `getEquipmentModels(q?: string): EquipmentModel[]` — `inventory_items WHERE kind='equipment' AND active=1 [AND name LIKE ?]` ORDER BY name; `type EquipmentModel = InventoryItem & { counts: {available;deployed;in_repair;retired} }` (join `countUnitsByStatus` per model, or a single grouped query). Keep `nextAssetTag` here.
- (No new table; reuse `getUnitsForItem`, `countUnitsByStatus`, `upsertUnit`, `setUnitStatus`, `getItemById`.)

### Unit 2 — `(equipment)` route group
`app/(app)/(equipment)/index.tsx`, `[id].tsx`, `add.tsx`:
- **index.tsx:** list `getEquipmentModels()` as `Card`s — `MediaThumbnail entityType="item" entityId={model.id} size={44}` + name + status-count chips (avail/deployed/repair). Search box (debounced) + pull-to-refresh (`syncNow` + reload). Empty state + a "＋ Add Equipment" CTA (gated `add_inventory`). Tap → `/(app)/(equipment)/[id]`.
- **[id].tsx:** model detail — header card with `MediaGallery entityType="item" entityId={id} canUpload={canUpload}` (the **model photo**), name/tag-prefix; then the units section **moved from inventory/[id]**: registered units list (status, current location/job), **Add Units** modal (asset-tag `BarcodeInput` scan + "Generate {prefix}" via `nextAssetTag` + serial), **Edit unit**, **Retire**, **Repair in/out + history**, per-unit media (`entity_type='equipment_unit'`). Reuse the exact handlers/logic from inventory/[id] (move, don't rewrite). Preserve `isWriteBlocked()` guards.
- **add.tsx:** create an equipment **model** — name, optional tag prefix, model photo (`MediaGallery entityType="item" entityId={newModelId}`; generate the model id up front), then optionally add initial units (asset tag + serial, with generate). Writes `upsertItem({...,kind:'equipment',unit_tracked:1,unit_category:'piece',unit:'each',...})` + outbox (booleans real, synced_at stripped — mirror inventory/add). No unit-of-measure picker.

### Unit 3 — Inventory becomes products-only
- `(inventory)/index.tsx`: filter the list to `kind='product'` (pass a kind filter to `searchItems`, or filter results). Equipment no longer appears here.
- `(inventory)/add.tsx`: **remove the product/equipment toggle** and the `kind==='equipment'` branch (always `kind='product'`); drop the unit-tracked/tag-prefix equipment sub-group (those live in the equipment add now). Keep product fields (name, unit_category/unit, etc.).
- `(inventory)/[id].tsx`: **remove the equipment-unit sections** (units list, add-units, edit/retire, repair) — they moved to equipment/[id]. Keep product stock-by-location, product media gallery, edit. If a `kind='equipment'` item somehow lands here, redirect to `/(app)/(equipment)/[id]`.

### Unit 4 — Navigation + entry points
- **Dashboard:** add an "🛠️ Equipment" tile (in the Inventory Management section, gated like Browse/Add) → `/(app)/(equipment)`.
- Anywhere that linked to an equipment item under `/(app)/(inventory)/[id]` (e.g. scan resolver for `INV:unit:` → unit's item) should route equipment-kind items to `/(app)/(equipment)/[id]`. Check `src/scan/resolveScan.ts` consumers + checkout/checkin "browse" entry points; update equipment-destined nav to the equipment route.

### Unit 5 — `EquipmentQuickAdd` retarget
- `EquipmentQuickAdd` (admin quick-add Stock/Equipment tab) keeps working (creates equipment models+units) — verify it still functions after the kind toggle removal in inventory/add (it's independent). No change required unless it imported something removed; if so, fix minimally.

---

## File map
| Unit | Files |
|---|---|
| 1 | `apps/mobile/src/db/queries/equipment.ts` (extend: getEquipmentModels) |
| 2 | `app/(app)/(equipment)/index.tsx`, `[id].tsx`, `add.tsx` (new) |
| 3 | `app/(app)/(inventory)/index.tsx`, `add.tsx`, `[id].tsx` |
| 4 | `app/(app)/(dashboard)/index.tsx`, `app/(app)/(inventory)/scan.tsx` (route equipment to equipment/[id]) |
| 5 | `src/components/quickadd/EquipmentQuickAdd.tsx` (verify/minimal) |

## Verification
- `tsc --noEmit` clean (mobile + api).
- Equipment tab: lists equipment models with photo thumbnails + status counts; tap → model detail with photo gallery + units; Add Units (scan + generate tag + serial) works; edit/retire/repair-history work; model photo uploads + shows.
- Inventory: shows ONLY products (no equipment); add form has no product/equipment toggle; product detail has no equipment-unit sections (still has product stock + media).
- Dashboard Equipment tile navigates correctly; scanning an `INV:unit:` QR opens the unit's equipment model under the Equipment tab.
- Checkout/checkin still deploy/return equipment units (unchanged logic).
- No data migration; existing equipment models + units appear under the new tab unchanged.

## Out of scope (build #2 + later)
- Product **class → curated units** + **conditional Owner** (next build, on the now-products-only Inventory).
- Moving equipment models to their own table (kept in inventory_items by design).
- Equipment maintenance scheduling / depreciation / QR for models (P2 covers item/unit QR already).
