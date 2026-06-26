## Task 1: Migration 006 — schema + sync plumbing

**Files:** create the two migration files; modify `schema.ts`, `sync.ts`, `pull.ts`, `items.ts`.

**Interfaces — Produces:**
- `inventory_items.unit_tracked` (local INTEGER 0/1; pg BOOLEAN), `tag_prefix` (TEXT null).
- `equipment_units(id, item_id, asset_tag, serial_number, status, current_location_id, current_job_id, notes, created_at, updated_at[, synced_at])`.
- `InventoryItem` gains `unit_tracked: number; tag_prefix: string | null;`.

- [ ] **Step 1: Postgres migration** — `apps/api/src/db/migrations/006_equipment_units.sql`:
```sql
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS unit_tracked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS tag_prefix TEXT;

CREATE TABLE IF NOT EXISTS equipment_units (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id             UUID NOT NULL REFERENCES inventory_items(id),
  asset_tag           TEXT NOT NULL,
  serial_number       TEXT,
  status              TEXT NOT NULL DEFAULT 'available',
  current_location_id UUID REFERENCES locations(id),
  current_job_id      UUID REFERENCES jobs(id),
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS equipment_units_asset_tag_idx ON equipment_units(asset_tag);
CREATE INDEX IF NOT EXISTS equipment_units_item_idx ON equipment_units(item_id);
```

- [ ] **Step 2: op-sqlite migration (version 6)** — `apps/mobile/src/db/migrations/006_equipment_units.ts`:
```typescript
import { DB } from '@op-engineering/op-sqlite';
export const migration = {
  version: 6,
  up: (db: DB): void => {
    db.executeSync(`ALTER TABLE inventory_items ADD COLUMN unit_tracked INTEGER NOT NULL DEFAULT 0`);
    db.executeSync(`ALTER TABLE inventory_items ADD COLUMN tag_prefix TEXT`);
    db.executeSync(`
      CREATE TABLE IF NOT EXISTS equipment_units (
        id                  TEXT PRIMARY KEY,
        item_id             TEXT NOT NULL,
        asset_tag           TEXT NOT NULL,
        serial_number       TEXT,
        status              TEXT NOT NULL DEFAULT 'available',
        current_location_id TEXT,
        current_job_id      TEXT,
        notes               TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        synced_at           TEXT
      )
    `);
    db.executeSync(`CREATE UNIQUE INDEX IF NOT EXISTS equipment_units_tag_idx ON equipment_units(asset_tag)`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS equipment_units_item_idx ON equipment_units(item_id)`);
  },
};
```

- [ ] **Step 3: Register m006** in `loadMigrations()` (import m006; add to array before `.sort()`).

- [ ] **Step 4: Server sync allowlists** — in `apps/api/src/routes/sync.ts` add `'equipment_units'` to BOTH `ALLOWED_TABLES` (push) and `FULL_TABLES` (full/pull). No CONFLICT_TARGETS entry (defaults to `id`).

- [ ] **Step 5: Pull mappings** — in `apps/mobile/src/sync/pull.ts`:
  - Add an `equipment_units` INSERT template:
    `equipment_units: \`INSERT OR REPLACE INTO equipment_units (id, item_id, asset_tag, serial_number, status, current_location_id, current_job_id, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)\`,`
  - Add the rowToValues case:
    `case 'equipment_units': return [row.id, row.item_id, row.asset_tag, row.serial_number ?? null, row.status, row.current_location_id ?? null, row.current_job_id ?? null, row.notes ?? null, row.created_at, row.updated_at];`
  - Extend the `inventory_items` template + rowToValues with `unit_tracked` and `tag_prefix` (after `returnable`): template adds `unit_tracked, tag_prefix` (+2 `?`); rowToValues adds `row.unit_tracked ? 1 : 0, row.tag_prefix ?? null`.

- [ ] **Step 6: items.ts** — add to `InventoryItem` (after `returnable`): `unit_tracked: number;` and `tag_prefix: string | null;`. Update `upsertItem` (column list + `?` + bindParams — currently 17, becomes 19, counts aligned). Add `unit_tracked`, `tag_prefix` to `updateItemFields` allowed `Pick<...>` keys.

- [ ] **Step 7: tsc** both apps exit 0.

- [ ] **Step 8: e2e** — rebuild api; get admin JWT; push an `equipment_units` INSERT (id, item_id = an existing item, asset_tag 'AM-9999', status 'available') via `/sync/push`; confirm `SELECT asset_tag, status FROM equipment_units WHERE asset_tag='AM-9999'` returns it; clean up. Also push an `inventory_items` UPDATE setting `unit_tracked:true, tag_prefix:'AM-'` and confirm.

- [ ] **Step 9: commit** `feat(equipment): migration 006 — equipment_units + unit_tracked/tag_prefix`.

---

