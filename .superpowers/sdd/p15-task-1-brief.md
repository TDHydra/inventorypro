## Task 1: Migration 005 — `category` + `returnable` (schema, sync, queries)

**Files:**
- Create `apps/api/src/db/migrations/005_item_category_returnable.sql`
- Create `apps/mobile/src/db/migrations/005_item_category_returnable.ts`
- Modify `apps/mobile/src/db/schema.ts` (register m005)
- Modify `apps/mobile/src/sync/pull.ts` (inventory_items template + rowToValues)
- Modify `apps/mobile/src/db/queries/items.ts` (`InventoryItem` interface, `upsertItem`, `updateItemFields` allowed keys, `getDistinctValues` whitelist)

- [ ] **Step 1: Postgres migration** — `apps/api/src/db/migrations/005_item_category_returnable.sql`:
```sql
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS returnable BOOLEAN NOT NULL DEFAULT FALSE;
-- Sensible backfill: existing equipment defaults to returnable.
UPDATE inventory_items SET returnable = TRUE WHERE kind = 'equipment';
```

- [ ] **Step 2: op-sqlite migration (version 5)** — `apps/mobile/src/db/migrations/005_item_category_returnable.ts`:
```typescript
import { DB } from '@op-engineering/op-sqlite';
export const migration = {
  version: 5,
  up: (db: DB): void => {
    db.executeSync(`ALTER TABLE inventory_items ADD COLUMN category TEXT`);
    db.executeSync(`ALTER TABLE inventory_items ADD COLUMN returnable INTEGER NOT NULL DEFAULT 0`);
    db.executeSync(`UPDATE inventory_items SET returnable = 1 WHERE kind = 'equipment'`);
  },
};
```

- [ ] **Step 3: Register m005** in `loadMigrations()` (import m005; add to the returned array; keep `.sort((a,b)=>a.version-b.version)`).

- [ ] **Step 4: Pull mapping** — in `apps/mobile/src/sync/pull.ts`, extend the `inventory_items` INSERT template and `rowToValues` case to include `category` and `returnable` (place them after `kind`):
  - template columns add `category, returnable`; add two `?`.
  - rowToValues add `row.category ?? null, row.returnable ? 1 : 0`.

- [ ] **Step 5: items.ts** — add to `InventoryItem` (after `kind`): `category: string | null;` and `returnable: number;`. Update `upsertItem` column list + values (add `category, returnable`, +2 `?`, +2 bindParams entries). Add `'category'` to `getDistinctValues`'s column whitelist union type and it works automatically. Add `category`, `returnable` to `updateItemFields`'s allowed `Pick<...>` keys.

- [ ] **Step 6: tsc** both apps exit 0.

- [ ] **Step 7: e2e** — rebuild api, push an item with `category` + `returnable:true`, confirm Postgres returns them; clean up. (Same pattern as migration 004's e2e.)

- [ ] **Step 8: commit** `feat(inventory): migration 005 — category + returnable`.

---

