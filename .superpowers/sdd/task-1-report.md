# Task 1 Report — Migration 004: item `kind` + location `owner_user_id`

**Status:** DONE  
**Commit:** b1459bd  
**Branch:** feat/inventory-products-movement

---

## Files Changed

| File | Action |
|------|--------|
| `apps/api/src/db/migrations/004_inventory_kind_location_owner.sql` | Created |
| `apps/mobile/src/db/migrations/004_inventory_kind_location_owner.ts` | Created |
| `apps/mobile/src/db/schema.ts` | Modified — registered m004 in `loadMigrations()` |
| `apps/mobile/src/sync/pull.ts` | Modified — updated INSERT templates + `rowToValues` for `locations` and `inventory_items` |
| `apps/mobile/src/db/queries/items.ts` | Modified — added `kind: string` to `InventoryItem`, updated `upsertItem` SQL + params |
| `apps/mobile/src/db/queries/locations.ts` | Modified — added `owner_user_id: string | null` to `Location`, updated `upsertLocation` SQL + params |
| `apps/mobile/app/(app)/(inventory)/add.tsx` | Modified — added `kind: 'product'` to `upsertItem` call (fixing TS literal error) |
| `apps/mobile/app/(app)/(locations)/index.tsx` | Modified — added `owner_user_id: null` to `upsertLocation` call (fixing TS literal error) |

---

## TypeScript Compile Results

### `apps/mobile` (`npx tsc --noEmit -p tsconfig.json`)
Initial run produced 2 errors:
- `app/(app)/(inventory)/add.tsx:88` — `kind` missing on `upsertItem` literal → fixed by adding `kind: 'product'`
- `app/(app)/(locations)/index.tsx:87` — `owner_user_id` missing on `upsertLocation` literal → fixed by adding `owner_user_id: null`

After fixes: **EXIT 0** (clean)

### `apps/api` (`npx tsc --noEmit`)
**EXIT 0** (clean, no errors)

---

## E2E Verification Output

```
AID=358683ed-72b7-45f1-9914-0bdc56bcaeaf
TOK_LEN=241
PUSH:{"ok":["t1"],"conflicts":[]}
QUERY RESULT: Test Air Mover|equipment
DELETE 1
```

The `/sync/push` accepted the `kind=equipment` payload, Postgres stored it correctly, and the cleanup deleted the test row. Migration 004 applied successfully on API boot.

---

## Concerns

None. The two extra file edits (`add.tsx`, `locations/index.tsx`) were expected by the brief ("Type errors here mean a missing `kind`/`owner_user_id` on a literal — fix the offending object") and the fixes are minimal and correct (defaulting new items to `kind: 'product'` and `owner_user_id: null`).
