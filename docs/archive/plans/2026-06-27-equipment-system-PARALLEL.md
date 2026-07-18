# Equipment as Its Own System — Implementation Plan

> Ultramode/SDD. Gate per task: `npx tsc --noEmit` clean (mobile + api). Implementers do NO git/tsc.

**Goal:** A dedicated Equipment tab (list/detail/add) with photo-per-model; Inventory becomes products-only. Data model unchanged (no migration).
**Architecture:** Equipment models = `inventory_items kind='equipment'`, units = `equipment_units`. New `(equipment)` route group; equipment-unit management MOVES out of `inventory/[id]`; inventory add drops the kind toggle. Model photos reuse the product media system (`entity_type='item'`).

## Global Constraints
- Expo SDK 56; op-sqlite binds string|number|null|ArrayBuffer. **No migration, no native, no new permission.**
- Equipment models: `kind='equipment'`, `unit_tracked=1`, `unit_category='piece'`, `unit='each'`. Units in `equipment_units`.
- MOVE logic out of inventory/[id]; don't duplicate. Preserve `isWriteBlocked()` write-guards + outbox boolean/synced_at handling.
- **Full spec: `docs/superpowers/specs/2026-06-27-equipment-system-design.md`** — ships with every brief.

---

# WAVE 0
### Task 1: getEquipmentModels query
**Files:** Modify `apps/mobile/src/db/queries/equipment.ts`.
**Produces:** `type EquipmentModel = InventoryItem & { counts: { available:number; deployed:number; in_repair:number; retired:number } }`; `getEquipmentModels(q?: string): EquipmentModel[]` (items WHERE kind='equipment' AND active=1 [AND name LIKE %q%] ORDER BY name; attach `countUnitsByStatus(id)` per model). Reuse `getDb`/`rowsAs`/`countUnitsByStatus` from equipmentUnits.ts.
- [ ] Controller: mobile tsc clean; commit `feat(equipment): getEquipmentModels query`.

# WAVE 1 (parallel after Task 1; file-disjoint)

### Task 2a: Equipment list + add screens
**Files:** Create `app/(app)/(equipment)/index.tsx`, `app/(app)/(equipment)/add.tsx`.
- [ ] **index.tsx:** `getEquipmentModels()` → `Card` rows: `MediaThumbnail entityType="item" entityId={m.id} size={44}` + name + status-count chips (avail/deployed/repair from m.counts). Debounced search, pull-to-refresh (`syncNow`+reload), `EmptyState` + "＋ Add Equipment" (gated `usePermission('add_inventory')`) → `/(app)/(equipment)/add`. Row → `/(app)/(equipment)/[id]`. Stack screen title "Equipment".
- [ ] **add.tsx:** create an equipment MODEL — generate the model id up front (`generateUUID`); fields: name, optional tag prefix; `MediaGallery entityType="item" entityId={modelId} canUpload` for the model photo; optionally add initial units (asset-tag `BarcodeInput` + "Generate {prefix}" via `nextAssetTag` + serial). On save: `upsertItem({id:modelId,name,kind:'equipment',unit_tracked:1,unit_category:'piece',unit:'each',tag_prefix,active:1,...})` + `appendOutbox('INSERT','inventory_items',{...real booleans, synced_at stripped})` (mirror inventory/add); for each unit `upsertUnit` + outbox. Preserve `isWriteBlocked()` guard. No unit-of-measure picker. Read inventory/add.tsx (equipment path) + EquipmentQuickAdd for the exact create logic to reuse.
- [ ] Controller: mobile tsc clean; commit `feat(equipment): list + add screens (photo per model)`.

### Task 2b: Equipment model detail ([id]) — extract unit management
**Files:** Create `app/(app)/(equipment)/[id].tsx`.
- [ ] READ `app/(app)/(inventory)/[id].tsx` fully. Build equipment/[id] for a `kind='equipment'` model: header card with `MediaGallery entityType="item" entityId={id} canUpload` (model photo) + name/tag-prefix; then **move the equipment-unit management** from inventory/[id]: registered-units list (status + current location/job via `getUnitsForItem`), **Add Units** modal (asset-tag BarcodeInput scan + "Generate" `nextAssetTag` + serial), **Edit unit**, **Retire** (`setUnitStatus`), **Repair in/out + history**, per-unit media (`entity_type='equipment_unit'`). Reuse the SAME handlers/queries (`upsertUnit`, `setUnitStatus`, `getUnitsForItem`, `nextAssetTag`, MediaGallery). Preserve `isWriteBlocked()` guards + outbox handling exactly. Use `getItemById(id)` for the model.
- [ ] Controller: mobile tsc clean; commit `feat(equipment): model detail + unit management`.

### Task 3: Inventory → products-only
**Files:** Modify `app/(app)/(inventory)/index.tsx`, `add.tsx`, `[id].tsx`.
- [ ] **index.tsx:** filter the list to `kind='product'` (pass a kind filter to `searchItems` or filter results) so equipment no longer shows.
- [ ] **add.tsx:** remove the product/equipment toggle + the `kind==='equipment'` branch + the unit-tracked/tag-prefix equipment sub-group; always `kind:'product'`. Keep product fields (name, unit_category/unit, etc.) and existing maintenance/synced_at/AdvancedFields handling.
- [ ] **[id].tsx:** REMOVE the equipment-unit sections (units list, add-units, edit/retire, repair, per-unit media) — they live in equipment/[id] now. Keep product stock-by-location, product MediaGallery, edit. Add a guard: if the loaded item `kind==='equipment'`, `router.replace('/(app)/(equipment)/[id]', {id})`.
- [ ] Controller: mobile tsc clean; commit `feat(inventory): products-only (drop equipment)`.

### Task 4: Dashboard tile + scan routing
**Files:** Modify `app/(app)/(dashboard)/index.tsx`, `app/(app)/(inventory)/scan.tsx`.
- [ ] Dashboard: add an "🛠️ Equipment" tile in the Inventory Management section (gated like Browse/Add) → `/(app)/(equipment)`.
- [ ] scan.tsx: when a resolved scan targets an equipment unit/model (the `INV:unit:` path resolves a unit whose item is `kind='equipment'`, or an `INV:item:` that's equipment), route to `/(app)/(equipment)/[id]` (with the model id) instead of `/(app)/(inventory)/[id]`. (Check the unit's item kind via getItemById.) Keep product/barcode paths unchanged.
- [ ] Controller: mobile tsc clean; commit `feat(nav): equipment dashboard tile + scan routing`.

### Task 5: EquipmentQuickAdd sanity
**Files:** `src/components/quickadd/EquipmentQuickAdd.tsx` (verify; minimal fix only).
- [ ] Confirm it still compiles + creates equipment models+units after Task 3 removes the inventory-add equipment path (EquipmentQuickAdd is independent; fix only if it imported something removed). No behavior change.
- [ ] Controller: mobile tsc clean; commit (only if changed) `chore(equipment): EquipmentQuickAdd post-split sanity`.

# SHIP (controller)
- [ ] App-wide tsc; whole-branch review (opus, focus: faithful extraction — equipment/[id] has ALL the unit mgmt inventory/[id] lost; no orphaned refs; write-guards intact; inventory truly products-only; photo wiring). Merge → main. JS-only (no migration/native) → dev client via Metro. Manual: Equipment tab end-to-end; Inventory shows no equipment.

## Self-Review
- Spec coverage: U1→T1; U2→T2a+T2b; U3→T3; U4→T4; U5→T5. ✔
- Collision: T1 equipment.ts; T2a equipment/index+add (new); T2b equipment/[id] (new); T3 inventory/index+add+[id]; T4 dashboard+scan; T5 EquipmentQuickAdd. T2b READS inventory/[id] (source) but WRITES only equipment/[id]; T3 WRITES inventory/[id] — no shared write. All Wave-1 disjoint. ✔
- Risk: T2b extraction faithfulness — final review must confirm equipment/[id] reproduces every unit-management capability inventory/[id] had.
