## Task 1: Migration 004 — `kind` + `owner_user_id` (schema + sync)

**Files:**
- Create: `apps/api/src/db/migrations/004_inventory_kind_location_owner.sql`
- Create: `apps/mobile/src/db/migrations/004_inventory_kind_location_owner.ts`
- Modify: `apps/mobile/src/db/schema.ts` (loadMigrations)
- Modify: `apps/mobile/src/sync/pull.ts`
- Modify: `apps/mobile/src/db/queries/items.ts` (InventoryItem + upsertItem)
- Modify: `apps/mobile/src/db/queries/locations.ts` (Location + upsertLocation)

**Interfaces:**
- Produces: `inventory_items.kind: 'product'|'equipment'` (local col `kind` TEXT default `'product'`); `locations.owner_user_id: string | null`. `InventoryItem.kind: string`; `Location.owner_user_id: string | null`.

- [ ] **Step 1: Postgres migration SQL**

Create `apps/api/src/db/migrations/004_inventory_kind_location_owner.sql`:
```sql
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'product';
ALTER TABLE locations ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id);
```

- [ ] **Step 2: op-sqlite migration (version 4)**

Create `apps/mobile/src/db/migrations/004_inventory_kind_location_owner.ts`:
```typescript
import { DB } from '@op-engineering/op-sqlite';

export const migration = {
  version: 4,
  up: (db: DB): void => {
    // Distinguish durable equipment from consumable products. Existing rows are
    // consumables → 'product' is the correct default.
    db.executeSync(`ALTER TABLE inventory_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'product'`);
    // A location may belong to a person (PM locker/vehicle). Nullable, general.
    db.executeSync(`ALTER TABLE locations ADD COLUMN owner_user_id TEXT`);
  },
};
```

- [ ] **Step 3: Register migration 004**

In `apps/mobile/src/db/schema.ts`, edit `loadMigrations()`:
```typescript
async function loadMigrations(): Promise<Migration[]> {
  const { migration: m001 } = await import('./migrations/001_initial');
  const { migration: m002 } = await import('./migrations/002_inventory_fields');
  const { migration: m003 } = await import('./migrations/003_user_pin_set');
  const { migration: m004 } = await import('./migrations/004_inventory_kind_location_owner');
  return [m001, m002, m003, m004].sort((a, b) => a.version - b.version);
}
```

- [ ] **Step 4: Pull mappings**

In `apps/mobile/src/sync/pull.ts`, update the `locations` and `inventory_items` INSERT templates and `rowToValues` cases to include the new columns:
```typescript
  locations: `INSERT OR REPLACE INTO locations (id, name, parent_id, color, icon, owner_user_id, updated_at) VALUES (?,?,?,?,?,?,?)`,
  inventory_items: `INSERT OR REPLACE INTO inventory_items (id, name, barcode, description, sku, supplier, model, kind, unit_category, unit, min_qty_alert, reorder_to, active, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
```
```typescript
    case 'locations': return [row.id, row.name, row.parent_id ?? null, row.color ?? null, row.icon ?? null, row.owner_user_id ?? null, row.updated_at];
    case 'inventory_items': return [row.id, row.name, row.barcode ?? null, row.description ?? null, row.sku ?? null, row.supplier ?? null, row.model ?? null, row.kind ?? 'product', row.unit_category, row.unit, row.min_qty_alert, row.reorder_to ?? null, row.active ? 1 : 0, row.updated_at];
```

- [ ] **Step 5: Mobile interfaces + upsert**

In `apps/mobile/src/db/queries/items.ts`, add `kind` to `InventoryItem` (after `model`):
```typescript
  model: string | null;
  kind: string; // 'product' | 'equipment'
```
And update `upsertItem` to include `kind`:
```typescript
    `INSERT OR REPLACE INTO inventory_items
       (id, name, barcode, description, sku, supplier, model, kind,
        unit_category, unit, min_qty_alert, reorder_to, active, updated_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindParams([item.id, item.name, item.barcode, item.description,
     item.sku, item.supplier, item.model, item.kind,
     item.unit_category, item.unit, item.min_qty_alert, item.reorder_to,
     item.active, item.updated_at, item.synced_at])
```
In `apps/mobile/src/db/queries/locations.ts`, add to `Location` interface (after `icon`): `owner_user_id: string | null;` and update `upsertLocation`'s column list + values to include `owner_user_id` (place it right before `updated_at`):
```typescript
    `INSERT OR REPLACE INTO locations (id, name, parent_id, color, icon, owner_user_id, updated_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    bindParams([location.id, location.name, location.parent_id, location.color,
     location.icon, location.owner_user_id, location.updated_at, location.synced_at])
```

- [ ] **Step 6: Compile gate**

Run: `cd ~/inventorypro/apps/mobile && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0. (Type errors here mean a missing `kind`/`owner_user_id` on a literal — fix the offending object.)

- [ ] **Step 7: Apply Postgres migration + e2e verify round-trip**

Rebuild API (runs migration), then push an item with `kind` and a location with `owner_user_id` and confirm both land:
```bash
cd ~/inventorypro/infra && sg docker -c "docker compose up -d --build api"; sleep 4
AID=$(sg docker -c "docker exec infra-postgres-1 psql -U inventorypro -d inventorypro -tAc \"SELECT id FROM users WHERE name='Alex Admin'\"" | tr -d '[:space:]')
TOK=$(curl -s -X POST http://localhost:3000/auth/token -H 'Content-Type: application/json' -d "{\"user_id\":\"$AID\",\"pin\":\"12345678\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['jwt'])")
curl -s -X POST http://localhost:3000/sync/push -H 'Content-Type: application/json' -H "Authorization: Bearer $TOK" -d "{\"entries\":[{\"id\":\"t1\",\"operation\":\"INSERT\",\"table_name\":\"inventory_items\",\"payload\":{\"id\":\"eeee0001-0001-0001-0001-000000000001\",\"name\":\"Test Air Mover\",\"kind\":\"equipment\",\"unit_category\":\"piece\",\"unit\":\"each\",\"min_qty_alert\":0,\"updated_at\":\"2026-06-26T12:00:00Z\"}}]}"
sg docker -c "docker exec infra-postgres-1 psql -U inventorypro -d inventorypro -tAc \"SELECT name, kind FROM inventory_items WHERE id='eeee0001-0001-0001-0001-000000000001'\""
# cleanup
sg docker -c "docker exec infra-postgres-1 psql -U inventorypro -d inventorypro -tAc \"DELETE FROM inventory_items WHERE id='eeee0001-0001-0001-0001-000000000001'\""
```
Expected: prints `Test Air Mover|equipment`.

- [ ] **Step 8: Checkpoint** — `tsc` clean + e2e prints the equipment row. (Commit if git initialized.)

---

