## Task 1 Report: Migration 005 — category + returnable

### Files Changed

| File | Change |
|------|--------|
| `apps/api/src/db/migrations/005_item_category_returnable.sql` | Created — Postgres migration |
| `apps/mobile/src/db/migrations/005_item_category_returnable.ts` | Created — op-sqlite migration v5 |
| `apps/mobile/src/db/schema.ts` | Registered m005 in `loadMigrations()` |
| `apps/mobile/src/sync/pull.ts` | Extended inventory_items template + rowToValues |
| `apps/mobile/src/db/queries/items.ts` | Extended InventoryItem, upsertItem, updateItemFields, getDistinctValues |
| `apps/mobile/app/(app)/(inventory)/add.tsx` | Added `category: null, returnable: 0` to new-item payload |

---

### TypeScript Results

- `apps/mobile` tsc: **exit 0** (one usage site in add.tsx needed `category` and `returnable` added)
- `apps/api` tsc: **exit 0** (no changes needed in API TypeScript sources)

---

### Column Counts

**pull.ts `inventory_items` template:**
Columns: `id, name, barcode, description, sku, supplier, model, kind, category, returnable, unit_category, unit, min_qty_alert, reorder_to, active, updated_at` = **16 columns, 16 `?`**
rowToValues entries: `[row.id, row.name, row.barcode ?? null, row.description ?? null, row.sku ?? null, row.supplier ?? null, row.model ?? null, row.kind ?? 'product', row.category ?? null, row.returnable ? 1 : 0, row.unit_category, row.unit, row.min_qty_alert, row.reorder_to ?? null, row.active ? 1 : 0, row.updated_at]` = **16 values** ✓

**items.ts `upsertItem`:**
Columns: `id, name, barcode, description, sku, supplier, model, kind, category, returnable, unit_category, unit, min_qty_alert, reorder_to, active, updated_at, synced_at` = **17 columns, 17 `?`**
bindParams entries: `[item.id, item.name, item.barcode, item.description, item.sku, item.supplier, item.model, item.kind, item.category, item.returnable, item.unit_category, item.unit, item.min_qty_alert, item.reorder_to, item.active, item.updated_at, item.synced_at]` = **17 values** ✓

---

### E2E Output

API rebuild applied migration 005 automatically on startup:

```
Applying migration 005_item_category_returnable.sql...
  ✓ Migration 5 applied
✓ 1 migration(s) applied.
```

Pushed inventory_items INSERT via `/sync/push` (Alex Admin JWT, `kind: "equipment"`, `category: "Filters"`, `returnable: true`):

```
{"ok":["outbox-001"],"conflicts":[]}
```

Postgres confirmation query:
```sql
SELECT name, category, returnable FROM inventory_items WHERE id='e2e5b50f-0001-0001-0001-000000000001'
```
Result:
```
E2E Test Filter|Filters|t
```

Test row cleaned up via DELETE sync push.

---

### Commit

`69a1fa2` — `feat(inventory): migration 005 — category + returnable`

---

### Concerns

None. All column/placeholder/value counts are exactly aligned. The only non-obvious change was add.tsx needing `category: null` and `returnable: 0` to satisfy the expanded `InventoryItem` interface — this is correct behavior for new items created before the user sets those fields.
