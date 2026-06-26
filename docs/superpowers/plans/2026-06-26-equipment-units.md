# Phase 2a: Equipment Unit-Tracking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use `- [ ]` checkboxes.

**Goal:** Let equipment items opt into per-unit tracking — each physical unit (asset tag, status, location) is its own record, with unit-level Add / Check Out / Check In / repair.

**Architecture:** Additive migration 006 adds `inventory_items.unit_tracked` + `tag_prefix` and a new `equipment_units` table. For a unit-tracked item, units are the source of truth for location and on-hand (derived = count of `available` units at a location); `stock_by_location` is untouched for those items. Movement screens branch: unit-tracked items select/scan specific units instead of a quantity.

**Tech Stack:** Expo SDK 56 + op-sqlite (mobile); Fastify + Postgres (api); Docker Compose dev stack.

## Global Constraints
- op-sqlite binds only string|number|null|ArrayBuffer; query helpers use `bindParams`. Booleans → 0/1 local, real boolean to the outbox (Postgres BOOLEAN).
- Additive migration registered in `loadMigrations()` (`apps/mobile/src/db/schema.ts`).
- Mobile reads local SQLite + writes via `appendOutbox`/`appendLog`; never REST GET.
- `appendLog` already enqueues its own activity_log outbox row — never separately outbox `activity_log`.
- Stock/unit outbox writes carry the FULL row (upsert by key); for stock counts use the ABSOLUTE post-adjust quantity (Phase 1 rule) — but unit-tracked items do NOT write `stock_by_location` at all.
- Gate: `npx tsc --noEmit -p tsconfig.json` (mobile) + `npx tsc --noEmit` (api), both exit 0. No jest exists — do not add it. Verify data-layer tasks with curl e2e against the dev stack; screen tasks are tsc + human on-device.
- Dev stack: `cd ~/inventorypro/infra && sg docker -c "docker compose up -d --build api"` (runs Postgres migration on boot). Postgres: `sg docker -c "docker exec infra-postgres-1 psql -U inventorypro -d inventorypro -tAc \"<SQL>\""`. Admin: Alex Admin / PIN 12345678.
- `equipment_units` is keyed by `id` (default conflict target — no CONFLICT_TARGETS entry needed).

## File Structure
- `apps/api/src/db/migrations/006_equipment_units.sql` — Postgres schema.
- `apps/mobile/src/db/migrations/006_equipment_units.ts` — op-sqlite schema (version 6).
- `apps/mobile/src/db/schema.ts` — register m006.
- `apps/api/src/routes/sync.ts` — `equipment_units` in ALLOWED_TABLES + FULL_TABLES.
- `apps/mobile/src/sync/pull.ts` — equipment_units template + rowToValues; inventory_items flags.
- `apps/mobile/src/db/queries/items.ts` — `unit_tracked`, `tag_prefix` on interface/upsert.
- `apps/mobile/src/db/queries/equipmentUnits.ts` — NEW unit query module.
- `apps/mobile/src/components/UnitRow.tsx` — NEW small unit display/select row.
- `apps/mobile/app/(app)/(inventory)/add.tsx`, `[id].tsx` — toggle, Add Units, roster, repair.
- `apps/mobile/app/(app)/(checkout)/index.tsx`, `(checkin)/index.tsx` — unit selection.

---

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

## Task 2: `equipmentUnits.ts` query module

**Files:** create `apps/mobile/src/db/queries/equipmentUnits.ts`.

**Interfaces — Produces:**
```typescript
export interface EquipmentUnit {
  id: string; item_id: string; asset_tag: string; serial_number: string | null;
  status: string; current_location_id: string | null; current_job_id: string | null;
  notes: string | null; created_at: string; updated_at: string; synced_at: string | null;
}
export function getUnitsForItem(itemId: string): EquipmentUnit[]
export function getAvailableUnitsAtLocation(itemId: string, locationId: string): EquipmentUnit[]
export function getUnitByTag(tag: string): EquipmentUnit | null
export function getDeployedUnitsForUser(userId: string): (EquipmentUnit & { item_name: string; job_name: string | null })[]
export function countUnitsByStatus(itemId: string): { available: number; deployed: number; in_repair: number; retired: number }
export function upsertUnit(u: EquipmentUnit): void  // local + caller outboxes
export function setUnitStatus(unitId: string, p: { status: string; current_location_id?: string | null; current_job_id?: string | null; notes?: string | null }): EquipmentUnit
```

- [ ] **Step 1: Implement the module.** Use `getDb()/executeSync/rowsAs/bindParams` like the other query files. Key bodies:
```typescript
export function getUnitsForItem(itemId: string): EquipmentUnit[] {
  const db = getDb();
  return rowsAs<EquipmentUnit>(db.executeSync(
    `SELECT * FROM equipment_units WHERE item_id = ? ORDER BY asset_tag`, [itemId]).rows);
}
export function getAvailableUnitsAtLocation(itemId: string, locationId: string): EquipmentUnit[] {
  const db = getDb();
  return rowsAs<EquipmentUnit>(db.executeSync(
    `SELECT * FROM equipment_units WHERE item_id = ? AND status = 'available' AND current_location_id = ? ORDER BY asset_tag`,
    [itemId, locationId]).rows);
}
export function getUnitByTag(tag: string): EquipmentUnit | null {
  const db = getDb();
  return (db.executeSync(`SELECT * FROM equipment_units WHERE asset_tag = ?`, [tag]).rows[0] as unknown as EquipmentUnit) ?? null;
}
export function countUnitsByStatus(itemId: string) {
  const db = getDb();
  const rows = db.executeSync(`SELECT status, COUNT(*) AS n FROM equipment_units WHERE item_id = ? GROUP BY status`, [itemId]).rows as { status: string; n: number }[];
  const out = { available: 0, deployed: 0, in_repair: 0, retired: 0 } as Record<string, number>;
  for (const r of rows) out[r.status] = r.n;
  return out as { available: number; deployed: number; in_repair: number; retired: number };
}
export function getDeployedUnitsForUser(userId: string) {
  // Units currently deployed, whose most recent checkout_to_job log was by this user.
  const db = getDb();
  return db.executeSync(
    `SELECT eu.*, i.name AS item_name, j.name AS job_name
     FROM equipment_units eu
     JOIN inventory_items i ON i.id = eu.item_id
     LEFT JOIN jobs j ON j.id = eu.current_job_id
     WHERE eu.status = 'deployed'
       AND EXISTS (SELECT 1 FROM activity_log al WHERE al.user_id = ?
                   AND al.action = 'checkout_to_job' AND al.note = 'unit ' || eu.asset_tag)
     ORDER BY eu.asset_tag`, [userId]).rows as any[];
}
export function upsertUnit(u: EquipmentUnit): void {
  const db = getDb();
  db.executeSync(
    `INSERT OR REPLACE INTO equipment_units
       (id, item_id, asset_tag, serial_number, status, current_location_id, current_job_id, notes, created_at, updated_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindParams([u.id, u.item_id, u.asset_tag, u.serial_number, u.status, u.current_location_id, u.current_job_id, u.notes, u.created_at, u.updated_at, u.synced_at]));
}
export function setUnitStatus(unitId: string, p: { status: string; current_location_id?: string | null; current_job_id?: string | null; notes?: string | null }): EquipmentUnit {
  const db = getDb();
  const now = new Date().toISOString();
  const cur = db.executeSync(`SELECT * FROM equipment_units WHERE id = ?`, [unitId]).rows[0] as unknown as EquipmentUnit;
  const next: EquipmentUnit = {
    ...cur, status: p.status,
    current_location_id: p.current_location_id !== undefined ? p.current_location_id : cur.current_location_id,
    current_job_id: p.current_job_id !== undefined ? p.current_job_id : cur.current_job_id,
    notes: p.notes !== undefined ? p.notes : cur.notes,
    updated_at: now, synced_at: null,
  };
  upsertUnit(next);
  return next;
}
```
Callers of `upsertUnit`/`setUnitStatus` also `appendOutbox('INSERT','equipment_units', {...row, updated_at})` with the returned row (full upsert; send no booleans — all unit fields are string/null).

- [ ] **Step 2: tsc** exit 0.
- [ ] **Step 3: commit** `feat(equipment): equipment_units query module`.

---

## Task 3: Item Add/Edit — `unit_tracked` toggle + `tag_prefix`

**Files:** modify `apps/mobile/app/(app)/(inventory)/add.tsx`, `[id].tsx`.

- [ ] **Step 1: add.tsx.** For equipment items only (kind==='equipment'), add a **"Track individual units"** `Switch` (`unitTracked` state) and, when on, a **"Tag prefix"** `TextInput` (`tagPrefix`, placeholder "AM-, DH-, MSC-…"). Include `unit_tracked: unitTracked ? 1 : 0` (local) / boolean (outbox) and `tag_prefix: tagPrefix.trim() || null` in the new-item payloads. When `unitTracked` is on, hide the quantity input + location picker and replace the Save button with a note: "Save the item, then add its units from the item screen." (Units are added in Task 4, not here — keep this screen's create path simple.)
- [ ] **Step 2: [id].tsx.** Edit mode (equipment): same toggle + tag-prefix field; persist via `updateItemFields` (`unit_tracked` number, `tag_prefix`) + outbox UPDATE (`unit_tracked` boolean). View mode shows "Individually tracked" + the prefix when set.
- [ ] **Step 3: tsc** exit 0.
- [ ] **Step 4: commit** `feat(inventory): unit-tracked toggle + tag prefix on add/edit`. (On-device by human.)

---

## Task 4: Add Units flow

**Files:** modify `apps/mobile/app/(app)/(inventory)/[id].tsx` (an "Add Units" modal on the item detail for unit-tracked items). Consumes Task 2 queries + `getAllLocations`, `BarcodeInput`, `generateUUID`, `appendOutbox`, `appendLog`, `useSession`.

- [ ] **Step 1.** On a unit-tracked item's detail, add an **"+ Add Units"** button (perm `add_inventory`) opening a modal: pick a **location** (`SearchablePicker` over `getAllLocations()`), then add unit rows — each row an **asset tag** `BarcodeInput` pre-filled with the item's `tag_prefix` (scannable) + optional serial. "+ Add another" appends a row. Live duplicate-tag detection via `getUnitByTag` (warn/block on an existing tag, and on a dup within the batch).
- [ ] **Step 2: save.** For each row (skip blank tags): `const id=generateUUID(); const now=new Date().toISOString();` build the unit `{ id, item_id: item.id, asset_tag, serial_number: serial||null, status:'available', current_location_id: locationId, current_job_id:null, notes:null, created_at:now, updated_at:now, synced_at:null }`; `upsertUnit(unit)`; `appendOutbox('INSERT','equipment_units', { ...unit (without synced_at), updated_at:now })`. After the batch, one `appendLog({ action:'add_units', entity_type:'item', entity_id:item.id, to_location_id:locationId, quantity: <count>, note:'units '+tags.join(','), ... })`. Refresh the roster.
- [ ] **Step 3: tsc** exit 0.
- [ ] **Step 4: commit** `feat(equipment): Add Units flow`. (On-device by human.)

---

## Task 5: Item detail — unit roster, repair, derived on-hand

**Files:** modify `apps/mobile/app/(app)/(inventory)/[id].tsx`; create `apps/mobile/src/components/UnitRow.tsx`.

- [ ] **Step 1: derived on-hand.** For a unit-tracked item, compute on-hand from units: replace the `getStockByItem`-based stock section with `countUnitsByStatus(item.id)` → show "N available · M deployed · K in repair" and per-location available counts (group `getUnitsForItem` by `current_location_id` where status='available'). Non-tracked items keep the Phase-1 stock-by-location view.
- [ ] **Step 2: roster.** Render a list of units (a `UnitRow` component: asset tag, status badge, current location/job). Perm-gated (`edit_inventory`) per-unit actions: **Send to repair** (prompt for a note → `setUnitStatus(id,{status:'in_repair', notes})` + outbox + `appendLog action:'repair_out'`), **Return from repair** (pick location → `setUnitStatus(id,{status:'available', current_location_id, notes:null})` + outbox + `appendLog action:'repair_in'`).
- [ ] **Step 3: tsc** exit 0.
- [ ] **Step 4: commit** `feat(equipment): unit roster + repair + derived on-hand`. (On-device by human.)

---

## Task 6: Check Out — unit selection for unit-tracked items

**Files:** modify `apps/mobile/app/(app)/(checkout)/index.tsx`. Consumes Task 2 queries.

- [ ] **Step 1.** After item select, branch on `selectedItem.unit_tracked`. For unit-tracked items, the `qty` step becomes a **unit-selection step**: list `getAvailableUnitsAtLocation(item.id, sourceLocationId)` with checkboxes + a scan-to-add affordance (scan an asset tag → select that unit if available at source). `selectedUnits: EquipmentUnit[]`. The source location is still chosen first (units are filtered to it).
- [ ] **Step 2: confirm writes.** For unit-tracked items, on confirm, for EACH selected unit call `setUnitStatus` + `appendOutbox('INSERT','equipment_units', row)` + `appendLog(... entity_type:'item', entity_id:item.id, note:'unit '+unit.asset_tag ...)`. By destination:
  - **Job:** `setUnitStatus(u.id,{status:'deployed', current_job_id: job.id, current_location_id: null})`; action `'checkout_to_job'` (returnable equipment) — note `'unit '+tag` (so `getDeployedUnitsForUser` finds it).
  - **Location:** `setUnitStatus(u.id,{status:'available', current_location_id: dest.id, current_job_id:null})`; action `'transfer'`, from=source, to=dest.
  - **PM:** `setUnitStatus(u.id,{status:'available', current_location_id: pmLocationId, current_job_id:null})`; action `'transfer'`.
  Unit-tracked items do NOT call `stockMove`/write `stock_by_location`. Non-tracked items keep the entire Phase-1 quantity path unchanged.
- [ ] **Step 3: tsc** exit 0.
- [ ] **Step 4: commit** `feat(checkout): unit selection + per-unit moves for tracked equipment`. (On-device by human.)

---

## Task 7: Check In — unit return

**Files:** modify `apps/mobile/app/(app)/(checkin)/index.tsx`. Consumes `getDeployedUnitsForUser`, `setUnitStatus`.

- [ ] **Step 1.** Add a section listing the user's deployed UNITS (`getDeployedUnitsForUser(user.id)`): asset tag + item + job. Select/scan units to return + pick a destination location (`SearchablePicker`). On confirm, for each: `setUnitStatus(u.id,{status:'available', current_location_id: dest.id, current_job_id:null})` + `appendOutbox('INSERT','equipment_units', row)` + `appendLog({action:'checkin', entity_type:'item', entity_id:u.item_id, to_location_id:dest.id, job_id:u.current_job_id, note:'unit '+u.asset_tag, ...})`. Keep the existing count-based job-checkout return section for non-tracked items.
- [ ] **Step 2: tsc** exit 0.
- [ ] **Step 3: commit** `feat(checkin): return tracked equipment units`. (On-device by human.)

---

## Final verification
- [ ] tsc clean both apps.
- [ ] Apply migration 006 to dev (rebuild api) and prod (rebuild image → ship via unraid skill → recreate api). Existing items default `unit_tracked=false`.
- [ ] On-device walkthrough: toggle an item to unit-tracked with prefix `AM-` → Add Units AM-0001/0002 at Warehouse → roster shows 2 available, item on-hand = 2 → Check Out AM-0001 To Job → it shows deployed, appears in Check In → Check In returns it available at Warehouse → Send AM-0002 to repair (note) → it drops from available count; return it. Duplicate tag blocked. All synced (equipment_units round-trips through `/sync/push`).
