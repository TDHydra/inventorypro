## Task 1 Report — Migration 006: equipment_units + unit_tracked/tag_prefix

### Files Changed

| File | Change |
|---|---|
| `apps/api/src/db/migrations/006_equipment_units.sql` | **Created** — Postgres migration: ALTER inventory_items (unit_tracked BOOLEAN, tag_prefix TEXT); CREATE equipment_units with unique/item indexes |
| `apps/mobile/src/db/migrations/006_equipment_units.ts` | **Created** — op-sqlite migration v6: same schema with INTEGER/TEXT types; synced_at column added |
| `apps/mobile/src/db/schema.ts` | **Modified** — imports m006 and adds to loadMigrations() array before .sort() |
| `apps/api/src/routes/sync.ts` | **Modified** — `equipment_units` added to both ALLOWED_TABLES and FULL_TABLES |
| `apps/mobile/src/sync/pull.ts` | **Modified** — added equipment_units INSERT template (10 cols) + rowToValues case (10 values); extended inventory_items template 16→18 cols + rowToValues 16→18 values |
| `apps/mobile/src/db/queries/items.ts` | **Modified** — InventoryItem gains unit_tracked/tag_prefix; upsertItem 17→19; updateItemFields Pick extended |
| `apps/mobile/app/(app)/(inventory)/add.tsx` | **Modified** — upsertItem call site: added unit_tracked:0, tag_prefix:null defaults (tsc error fix) |

### TypeScript Results

- `apps/mobile`: `npx tsc --noEmit -p tsconfig.json` → **exit 0** (no errors)
- `apps/api`: `npx tsc --noEmit` → **exit 0** (no errors)

### Column Counts

| Location | Columns | Placeholders (?) | Values |
|---|---|---|---|
| `upsertItem` (items.ts) | 19 | 19 | 19 |
| `inventory_items` template (pull.ts) | 18 | 18 | 18 |
| `equipment_units` template (pull.ts) | 10 | 10 | 10 |

**inventory_items cols in pull.ts (18):** id, name, barcode, description, sku, supplier, model, kind, category, returnable, unit_tracked, tag_prefix, unit_category, unit, min_qty_alert, reorder_to, active, updated_at

**equipment_units cols in pull.ts (10):** id, item_id, asset_tag, serial_number, status, current_location_id, current_job_id, notes, created_at, updated_at

**upsertItem cols (19):** id, name, barcode, description, sku, supplier, model, kind, category, returnable, unit_tracked, tag_prefix, unit_category, unit, min_qty_alert, reorder_to, active, updated_at, synced_at

### E2E Test Outputs

**API rebuild:** Docker build succeeded; API container restarted healthy (HTTP 200).

**Admin JWT:** Obtained via `/auth/token` for Alex Admin (358683ed-72b7-45f1-9914-0bdc56bcaeaf).

**Existing item_id used:** `bbbbbbbb-0001-0001-0001-000000000001`

**equipment_units INSERT via /sync/push:**
```json
{ "ok": ["8f892037-e692-4627-b14c-235b26dbb993"], "conflicts": [] }
```
Verify: `SELECT asset_tag, status FROM equipment_units WHERE asset_tag='AM-9999'` → `AM-9999|available` ✓

**inventory_items UPDATE (unit_tracked:true, tag_prefix:'AM-') via /sync/push:**
```json
{ "ok": ["30773afc-cb8e-4370-b412-e29d87adfdde"], "conflicts": [] }
```
Verify: `SELECT unit_tracked, tag_prefix FROM inventory_items WHERE id='bbbbbbbb-0001-0001-0001-000000000001'` → `t|AM-` ✓

**Cleanup:** equipment_units test row deleted (0 rows remaining); inventory_items restored to unit_tracked=false, tag_prefix=NULL.

### Concerns

None. All steps passed cleanly. The only unexpected wrinkle was a call site in `add.tsx` that constructs an `InventoryItem` literal and needed `unit_tracked:0, tag_prefix:null` defaults — caught by tsc and fixed before commit.
