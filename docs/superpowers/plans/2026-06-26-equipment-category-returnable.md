# Phase 1.5: equipment units, dynamic Category, per-item Returnable

> **For agentic workers:** implement task-by-task; each ends with `tsc --noEmit` (no jest exists) + (where noted) curl e2e against the local dev stack. Checkbox steps.

**Goal:** Equipment items use pieces; every item gets a dynamic autofilled `Category`; each item carries a `returnable` flag that drives whether a To-Job checkout is outstanding (Check In) or consumed.

**Tech:** Expo SDK 56 + op-sqlite (mobile); Fastify + Postgres (api). Additive migration, no wipe.

## Global Constraints
- op-sqlite binds only string|number|null|ArrayBuffer; query helpers use `bindParams`. Store booleans as 0/1 locally; send real booleans to the outbox (Postgres BOOLEAN).
- Additive migration registered in `loadMigrations()` (`apps/mobile/src/db/schema.ts`).
- Mobile reads local SQLite + writes via `appendOutbox`/`appendLog`; never REST GET.
- Gate: `npx tsc --noEmit -p tsconfig.json` (mobile) + `npx tsc --noEmit` (api), both exit 0.
- Dev stack: `cd ~/inventorypro/infra && sg docker -c "docker compose up -d --build api"` (runs Postgres migration on boot). Postgres: `sg docker -c "docker exec infra-postgres-1 psql -U inventorypro -d inventorypro -tAc \"<SQL>\""`.

---

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

## Task 2: Add + edit screens — equipment pieces, Category, Returnable

**Files:**
- Modify `apps/mobile/app/(app)/(inventory)/add.tsx`
- Modify `apps/mobile/app/(app)/(inventory)/[id].tsx`

- [ ] **Step 1: add.tsx — equipment unit lock.** When the create-mode `kind` is `'equipment'`: set `unit_category='piece'` and `unit='each'`, and HIDE the unit-category selector + unit chip row (show a small read-only "Unit: each (piece)" line instead). When `kind='product'`, keep today's unit-category + unit pickers. Wire this off the existing kind toggle so flipping kind updates the unit state.

- [ ] **Step 2: add.tsx — Category field.** Add a `category` state + a `SuggestInput` labeled "Category" with `suggestions={getDistinctValues('category')}` (memoized once), placeholder e.g. "Air Movers, Filters, Equipment Inventory…". Include `category: category.trim() || null` in the new-item `upsertItem` payload AND the `appendOutbox('INSERT','inventory_items',{...})` payload.

- [ ] **Step 3: add.tsx — Returnable toggle.** Add a `returnable` boolean state. Default it from kind: when kind becomes `'equipment'` default `true`, `'product'` default `false` (set on kind change, but let the user override afterward). Render a `Switch` labeled "Returnable? (expected back via Check In)". Include `returnable` in the payloads — local `upsertItem` as `returnable ? 1 : 0`; outbox as the boolean `returnable`.

- [ ] **Step 4: [id].tsx — show + edit.** In view mode, show Category and a "Returnable" / "Consumed" badge. In edit mode, add a Category `SuggestInput` and a Returnable `Switch`; include `category` and `returnable` in the `updateItemFields(...)` call + the `appendOutbox('UPDATE','inventory_items',{...})` payload (send `returnable` as a boolean to the outbox). For equipment items, also apply the same unit lock as the add screen.

- [ ] **Step 5: tsc** exit 0.

- [ ] **Step 6: commit** `feat(inventory): equipment pieces + Category + Returnable on add/edit`. (On-device verification by the human.)

---

## Task 3: Check Out To-Job honors `returnable`

**Files:**
- Modify `apps/mobile/app/(app)/(checkout)/index.tsx`

- [ ] **Step 1:** In the To-Job confirm path, read the selected item's returnable flag via `getItemById(selectedItem.id)?.returnable` (it's on the full row after migration 005). Choose the action:
  - `returnable` truthy → keep `action: 'checkout_to_job'` (outstanding; surfaces in Check In via `getActiveCheckoutsForUser`).
  - `returnable` falsy → `action: 'consumed'` (deducts source, does NOT appear in Check In — it's used up).
  In both cases the stock write is identical (source `-qty`, absolute outbox qty); only the log `action` differs. Location and PM destinations are unchanged (`transfer`).

- [ ] **Step 2:** (optional polish) On the confirm screen for a Job destination, label it "Deploy (returnable)" vs "Consume" based on the flag so the user sees which it'll be. Keep minimal.

- [ ] **Step 3: tsc** exit 0.

- [ ] **Step 4: commit** `feat(checkout): To-Job consumes non-returnable items, deploys returnable ones`.

---

## Final
- [ ] tsc clean both apps.
- [ ] Apply migration 005 to dev (rebuild api) and prod (rebuild image → ship via unraid skill → recreate api). Existing equipment backfills `returnable=true`.
- [ ] On-device: add an equipment item (unit auto = each) with a Category; mark a filter consumed; check it out To-Job → consumed item does NOT show in Check In, returnable one does.
