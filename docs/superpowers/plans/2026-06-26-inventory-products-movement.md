# Inventory Foundation + Products + Movement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "adding inventory" stock an item at a location, add a general location-ownership primitive, and restructure Check Out into Job / Location / Production-Manager destinations (+ Check In), all with live search and barcode auto-fill.

**Architecture:** Additive DB migration (Postgres ALTER + op-sqlite ALTER) introduces an item `kind` flag and `locations.owner_user_id`. Stock stays count-based in `stock_by_location`. A reusable `SearchablePicker` drives every entity selector. Mobile writes go through the existing local-SQLite + outbox path; the server `/sync/push` is column-dynamic so new columns flow automatically.

**Tech Stack:** Expo SDK 56 + expo-router + @op-engineering/op-sqlite (mobile); Fastify + Postgres (api); Docker Compose dev stack.

## Global Constraints

- **No test framework exists.** Verify with `npx tsc --noEmit` (compile gate) + curl/node end-to-end against the local dev API + on-device manual checks. Do NOT add jest/vitest.
- **Repo is not under git.** "Commit" = a verify checkpoint. (If you want real commits, run `git init` in `~/inventorypro` first; otherwise skip.)
- **op-sqlite binds only string | number | null | ArrayBuffer.** Use `bindParams([...])` for any insert/update with booleans/objects. Booleans → store as `0/1` locally; send real booleans to the outbox (Postgres columns are BOOLEAN).
- **Additive migrations only** — no data wipe, no APK rebuild. New SQLite migration must be registered in `loadMigrations()` in `apps/mobile/src/db/schema.ts`.
- **Mobile reads local SQLite only; never calls REST GET.** All writes: local query helper + `appendOutbox(op, table, payload)`.
- **Dev stack commands:** `cd ~/inventorypro/infra && sg docker -c "docker compose up -d --build api"` rebuilds/restarts the API (runs Postgres migrations on boot). Postgres: `sg docker -c "docker exec infra-postgres-1 psql -U inventorypro -d inventorypro -tAc \"<SQL>\""`. Local API base: `http://localhost:3000`.
- **Equipment in this phase is count-based + returnable** (unit-level tracking is Phase 2). `kind` default is `'product'`.

---

## File Structure

- `apps/api/src/db/migrations/004_inventory_kind_location_owner.sql` — Postgres ALTERs.
- `apps/mobile/src/db/migrations/004_inventory_kind_location_owner.ts` — op-sqlite ALTERs (version 4).
- `apps/mobile/src/db/schema.ts` — register migration 004.
- `apps/mobile/src/sync/pull.ts` — add `kind` / `owner_user_id` to pull SQL + rowToValues.
- `apps/mobile/src/db/queries/items.ts` — `kind` in interface/upsert; `getItemByBarcode` already returns full row.
- `apps/mobile/src/db/queries/locations.ts` — `owner_user_id`; `getLocationsByOwner`.
- `apps/mobile/src/db/queries/users.ts` — `getUsersByRole`.
- `apps/mobile/src/components/SearchablePicker.tsx` — reusable entity dropdown (new).
- `apps/mobile/app/(app)/(inventory)/add.tsx` — combined Add-Stock-to-Location.
- `apps/mobile/app/(app)/(locations)/index.tsx` — owner picker.
- `apps/mobile/app/(app)/(checkout)/index.tsx` — destination restructure.
- `apps/mobile/app/(app)/(checkin)/index.tsx` — return-to-location confirm.
- `apps/mobile/app/(app)/(dashboard)/index.tsx` — tile labels/wiring.

---

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

## Task 2: Query-layer helpers — `getUsersByRole`, `getLocationsByOwner`, sync-enabled `appendLog`

**Files:**
- Modify: `apps/mobile/src/db/queries/users.ts`
- Modify: `apps/mobile/src/db/queries/locations.ts`
- Modify: `apps/mobile/src/db/queries/log.ts`

**Interfaces:**
- Consumes: `User` (users.ts), `Location` (locations.ts), `appendOutbox` (sync/outbox.ts).
- Produces: `getUsersByRole(role: string): User[]`; `getLocationsByOwner(ownerUserId: string): Location[]`. `appendLog(...)` now also enqueues the row to the sync outbox so on-device moves reach the server's immutable log.

> **Why the appendLog change:** today `appendLog` writes the row to local SQLite only and returns void, so checkout/checkin logs never sync. The server already accepts `activity_log` via idempotent `WHERE NOT EXISTS` inserts on `/sync/push`. Making `appendLog` outbox the exact row it just inserted (same `id` + `created_at`) fixes this for every caller at once — no caller changes needed.

- [ ] **Step 1: getUsersByRole**

In `apps/mobile/src/db/queries/users.ts` add:
```typescript
// Active users of a given role — e.g. the production-manager dropdown in checkout.
export function getUsersByRole(role: string): User[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM users WHERE active = 1 AND role = ? ORDER BY name`,
    [role]
  );
  return rowsAs<User>(result.rows);
}
```

- [ ] **Step 2: getLocationsByOwner**

In `apps/mobile/src/db/queries/locations.ts` add:
```typescript
// Locations that belong to a user (a PM's locker/vehicle, etc.).
export function getLocationsByOwner(ownerUserId: string): Location[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM locations WHERE owner_user_id = ? ORDER BY name`,
    [ownerUserId]
  );
  return rowsAs<Location>(result.rows);
}
```

- [ ] **Step 3: Sync-enable `appendLog`**

In `apps/mobile/src/db/queries/log.ts`, import the outbox and make `appendLog` enqueue the same row after inserting it locally:
```typescript
import { getDb, rowsAs } from '../schema';
import { generateUUID } from '../../utils/uuid';
import { appendOutbox } from '../../sync/outbox';
```
```typescript
export function appendLog(entry: Omit<LogEntry, 'id' | 'created_at' | 'synced_at'>): void {
  const db = getDb();
  const id = generateUUID();
  const created_at = new Date().toISOString();
  db.executeSync(
    `INSERT INTO activity_log
       (id, user_id, team_id, action, entity_type, entity_id,
        from_location_id, to_location_id, quantity, unit, job_id,
        note, metadata, device_id, created_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [id, entry.user_id, entry.team_id, entry.action, entry.entity_type,
     entry.entity_id, entry.from_location_id, entry.to_location_id,
     entry.quantity, entry.unit, entry.job_id, entry.note,
     entry.metadata, entry.device_id, created_at]
  );
  // Sync the row to the server's append-only log (idempotent insert server-side).
  appendOutbox('INSERT', 'activity_log', {
    id, user_id: entry.user_id, team_id: entry.team_id, action: entry.action,
    entity_type: entry.entity_type, entity_id: entry.entity_id,
    from_location_id: entry.from_location_id, to_location_id: entry.to_location_id,
    quantity: entry.quantity, unit: entry.unit, job_id: entry.job_id,
    note: entry.note, metadata: entry.metadata, device_id: entry.device_id, created_at,
  });
}
```

- [ ] **Step 4: Compile gate**

Run: `cd ~/inventorypro/apps/mobile && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 5: e2e verify a log syncs**

Trigger any log (e.g. add stock in a later task, or temporarily call appendLog) and confirm it reaches Postgres:
```bash
sg docker -c "docker exec infra-postgres-1 psql -U inventorypro -d inventorypro -tAc \"SELECT action, count(*) FROM activity_log GROUP BY action ORDER BY action\""
```
Expected: `add_stock`/`checkout`/`checkin`/`transfer` rows appear after on-device actions (verified end-to-end in Tasks 4–7).

- [ ] **Step 6: Checkpoint** — `tsc` clean; `appendLog` now enqueues to the outbox.

---

## Task 3: `SearchablePicker` component

**Files:**
- Create: `apps/mobile/src/components/SearchablePicker.tsx`

**Interfaces:**
- Produces:
```typescript
interface PickerOption { id: string; label: string; sublabel?: string }
interface SearchablePickerProps {
  placeholder?: string;
  options: PickerOption[];
  value: PickerOption | null;
  onSelect: (opt: PickerOption) => void;
  onCreate?: (text: string) => void; // when present, shows "Create '<text>'" if no exact match
  autoFocus?: boolean;
}
export function SearchablePicker(props: SearchablePickerProps): JSX.Element
```

- [ ] **Step 1: Implement the component**

Create `apps/mobile/src/components/SearchablePicker.tsx`:
```typescript
import { useState, useMemo } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';

export interface PickerOption { id: string; label: string; sublabel?: string }

interface Props {
  placeholder?: string;
  options: PickerOption[];
  value: PickerOption | null;
  onSelect: (opt: PickerOption) => void;
  onCreate?: (text: string) => void;
  autoFocus?: boolean;
}

// Live-filtering entity dropdown: type to narrow existing rows to a tappable list,
// collapse to the single match, and (when onCreate is given) offer to create a new
// one when nothing matches. Used for item/location/job/PM selection so the behavior
// is identical everywhere.
export function SearchablePicker({ placeholder, options, value, onSelect, onCreate, autoFocus }: Props) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options.slice(0, 8);
    return options.filter(o =>
      o.label.toLowerCase().includes(q) || (o.sublabel?.toLowerCase().includes(q) ?? false)
    ).slice(0, 8);
  }, [query, options]);

  const exact = useMemo(
    () => options.find(o => o.label.trim().toLowerCase() === query.trim().toLowerCase()) ?? null,
    [query, options]
  );
  const showCreate = !!onCreate && query.trim().length > 0 && !exact;
  const open = focused && (matches.length > 0 || showCreate);

  if (value) {
    return (
      <TouchableOpacity style={s.selected} onPress={() => { onSelect(value); setQuery(''); }}>
        <View style={{ flex: 1 }}>
          <Text style={s.selectedLabel}>{value.label}</Text>
          {!!value.sublabel && <Text style={s.selectedSub}>{value.sublabel}</Text>}
        </View>
        <Text style={s.change}>Change</Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={s.wrap}>
      <TextInput
        style={s.input}
        placeholder={placeholder}
        placeholderTextColor="#94A3B8"
        value={query}
        onChangeText={setQuery}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        autoFocus={autoFocus}
      />
      {open && (
        <ScrollView style={s.dropdown} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
          {matches.map(o => (
            <TouchableOpacity key={o.id} style={s.row} onPress={() => { onSelect(o); setQuery(''); setFocused(false); }}>
              <Text style={s.rowLabel}>{o.label}</Text>
              {!!o.sublabel && <Text style={s.rowSub}>{o.sublabel}</Text>}
            </TouchableOpacity>
          ))}
          {showCreate && (
            <TouchableOpacity style={[s.row, s.createRow]} onPress={() => { onCreate!(query.trim()); setFocused(false); }}>
              <Text style={s.createText}>+ Create “{query.trim()}”</Text>
            </TouchableOpacity>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { position: 'relative' },
  input: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0', paddingHorizontal: 14, height: 44, fontSize: 14, color: '#1E293B' },
  dropdown: { maxHeight: 240, backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0', marginTop: 4 },
  row: { paddingHorizontal: 14, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  rowLabel: { fontSize: 14, color: '#1E293B' },
  rowSub: { fontSize: 12, color: '#94A3B8', marginTop: 1 },
  createRow: { backgroundColor: '#EFF6FF' },
  createText: { fontSize: 14, color: '#1D4ED8', fontWeight: '600' },
  selected: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F1F5F9', borderRadius: 10, paddingHorizontal: 14, height: 44 },
  selectedLabel: { fontSize: 14, color: '#1E293B', fontWeight: '600' },
  selectedSub: { fontSize: 12, color: '#64748B', marginTop: 1 },
  change: { color: '#2563EB', fontSize: 13, fontWeight: '600' },
});
```

- [ ] **Step 2: Compile gate**

Run: `cd ~/inventorypro/apps/mobile && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 3: Checkpoint** — `tsc` clean. (Manual render verified in Task 6 where it's first used.)

---

## Task 4: Add Stock to Location (combined `add.tsx`)

**Files:**
- Modify: `apps/mobile/app/(app)/(inventory)/add.tsx`

**Interfaces:**
- Consumes: `getItemByBarcode` (items.ts, returns full `InventoryItem | null`), `searchItems`, `upsertItem`, `adjustStock`, `getDistinctValues` (items.ts); `getAllLocations` (locations.ts); `SearchablePicker` (Task 3); `appendLog` (log.ts); `appendOutbox` (outbox.ts); `useSession`.

- [ ] **Step 1: Rewrite the screen as find-or-create + location + qty**

Replace `apps/mobile/app/(app)/(inventory)/add.tsx` with a flow that:
1. Has an **item** step: a `SearchablePicker` over existing items (label=name, sublabel=barcode/kind) with `onCreate` revealing the catalog fields; PLUS a `BarcodeInput`. On barcode change, call `getItemByBarcode(code)`; if found, set the selected item and **auto-fill** name/kind/unit/supplier/model into read-only state (add-to-existing mode). If not found and the user proceeds, the catalog fields (name, kind toggle `product`/`equipment`, unit category/unit, supplier `SuggestInput`, model `SuggestInput`, reorder) are editable to create it.
2. Has a **location** `SearchablePicker` over `getAllLocations()` (label=name, sublabel=parent name).
3. Has a **quantity** numeric input.
4. On Save:
```typescript
const now = new Date().toISOString();
let itemId = selectedItem?.id;
if (!itemId) { // creating a new catalog item
  itemId = generateUUID();
  const payload = {
    id: itemId, name: name.trim(), barcode: barcode.trim() || null,
    description: description.trim() || null, sku: null,
    supplier: supplier.trim() || null, model: model.trim() || null,
    kind, unit_category: category, unit,
    min_qty_alert: parseFloat(minAlert) || 0,
    reorder_to: reorderTo.trim() ? parseFloat(reorderTo) : null,
  };
  upsertItem({ ...payload, active: 1, updated_at: now, synced_at: null });
  appendOutbox('INSERT', 'inventory_items', { ...payload, active: true, updated_at: now });
}
const qty = parseFloat(quantity) || 0;
adjustStock(itemId, locationId, qty);                       // local +qty
const newQty = getStockQuantity(itemId, locationId);
appendOutbox('INSERT', 'stock_by_location', { item_id: itemId, location_id: locationId, quantity: newQty, updated_at: now });
appendLog({ user_id: user.id, team_id: null, action: 'add_stock', entity_type: 'item', entity_id: itemId,
  from_location_id: null, to_location_id: locationId, quantity: qty, unit, job_id: null,
  note: null, metadata: null, device_id: null }); // appendLog now also enqueues to the outbox (Task 2)
```
Keep Clear + Cancel buttons. Reuse the existing screen's styles/`BarcodeInput`/`SuggestInput`; only the structure changes (add item-picker + location-picker + quantity; gate catalog fields behind "new item").

> Note: send `stock_by_location` to the outbox as an INSERT carrying the **absolute** post-adjust `quantity` (via `getStockQuantity`) — this matches the server `applyEntry` upsert keyed by `(item_id, location_id)` (see the sync write-path notes). Send `is_*`/numeric values directly; no booleans here.

- [ ] **Step 2: Compile gate**

Run: `cd ~/inventorypro/apps/mobile && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 3: On-device manual verify**

Restart Metro with `--clear` (picks up migration 4 + screens):
`cd ~/inventorypro/apps/mobile && EXPO_PUBLIC_API_URL=http://localhost:3000 npx expo start --dev-client --localhost --clear` (and `adb reverse tcp:8081 tcp:8081; adb reverse tcp:3000 tcp:3000`). Open the app → Add Stock to Location.
- Scan/type an existing barcode → fields auto-fill, catalog fields read-only.
- Pick a location, enter qty 5, Save.
- Open the item detail → its "Stock by location" shows +5 at that location.
Expected: stock visible; no "object is not an arrayBuffer" errors in Metro.

- [ ] **Step 4: e2e verify the stock synced**

After the app syncs (foreground a few seconds), confirm the row server-side:
```bash
sg docker -c "docker exec infra-postgres-1 psql -U inventorypro -d inventorypro -tAc \"SELECT quantity FROM stock_by_location s JOIN inventory_items i ON i.id=s.item_id WHERE i.name LIKE '%<your item>%' ORDER BY s.updated_at DESC LIMIT 1\""
```
Expected: the quantity you added.

- [ ] **Step 5: Checkpoint** — `tsc` clean + on-device stock add works + server row matches.

---

## Task 5: Locations owner picker

**Files:**
- Modify: `apps/mobile/app/(app)/(locations)/index.tsx`

**Interfaces:**
- Consumes: `getAllActiveUsers` (users.ts) for the person list; existing `upsertLocation` (now writes `owner_user_id`); `appendOutbox`.

- [ ] **Step 1: Add an optional "Belongs to (person)" field to the create/edit modal**

In the location create modal state, add `ownerId: string | null` (default null). Render a `SearchablePicker` (options = active users, label=name, sublabel=role) labeled "Belongs to (optional)". Include `owner_user_id: ownerId` in both the `upsertLocation({...})` payload and the `appendOutbox('INSERT','locations', { ... owner_user_id: ownerId })` payload. On owned-location cards, show `Owner: <name>` when set.

- [ ] **Step 2: Compile gate**

Run: `cd ~/inventorypro/apps/mobile && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 3: On-device + e2e verify**

Create a location "Pete's Van", owner = a user. Confirm it appears with the owner, then:
```bash
sg docker -c "docker exec infra-postgres-1 psql -U inventorypro -d inventorypro -tAc \"SELECT name, owner_user_id IS NOT NULL AS owned FROM locations WHERE name='Pete''s Van'\""
```
Expected: `Pete's Van|t`.

- [ ] **Step 4: Checkpoint** — owner persists locally and syncs.

---

## Task 6: Check Out — destination Job / Location / Production Manager

**Files:**
- Modify: `apps/mobile/app/(app)/(checkout)/index.tsx`

**Interfaces:**
- Consumes: `searchItems`, `getItemById`, `getStockByItem`, `adjustStock`, `getStockQuantity` (items.ts); `getOpenJobs`, `searchJobs`, `upsertJob` (jobs.ts); `getAllLocations`, `getLocationsByOwner` (locations.ts); `getUsersByRole` (Task 2); `SearchablePicker` (Task 3); `appendLog`, `appendOutbox`, `useSession`.

- [ ] **Step 1: Restructure the wizard steps**

Change the step machine to `'find' | 'qty' | 'dest' | 'confirm'`. Steps `find` (item) and `qty` (source location + quantity) keep today's logic but use `SearchablePicker` for item + source location. Replace the old "job + who-for" step with a **`dest` step** showing three buttons: **To Job**, **To Location**, **To Production Manager**, setting `destType: 'job' | 'location' | 'pm'`.

- [ ] **Step 2: Destination sub-flows**

```typescript
// To Job: SearchablePicker over getOpenJobs()/searchJobs(q), onCreate -> upsertJob + outbox.
//   On confirm: adjustStock(item, source, -qty); appendOutbox stock INSERT (absolute qty);
//   appendLog action 'checkout' from_location=source, to_location=null, job_id=job.id, quantity.
//   (Product or equipment both deduct source; equipment stays an open checkout for Check In.)

// To Location: SearchablePicker over getAllLocations() (exclude source). On confirm:
//   adjustStock(item, source, -qty); adjustStock(item, dest, +qty);
//   appendOutbox two stock INSERTs (absolute qty each via getStockQuantity);
//   appendLog action 'transfer' from_location=source, to_location=dest, quantity.

// To Production Manager: modal asks single vs multiple.
//   pmTargets: Array<{ pmId: string; locationId: string; qty: number }>
//   - Single: pick one PM (getUsersByRole('production_manager')); their locations =
//     getLocationsByOwner(pmId); if exactly one, preselect; else pick. qty = the step qty.
//   - Multiple: select PMs; for each, pick a location (preselect if one) and enter a qty.
//   On confirm, for each target: adjustStock(item, source, -qty); adjustStock(item, target.locationId, +qty);
//   appendOutbox stock INSERTs; appendLog action 'checkout' from_location=source,
//   to_location=target.locationId, quantity=target.qty, note=`PM:<name>`.
//   Guard: sum(target.qty) <= source on-hand (getStockQuantity).
```
Remove the old self/team/office "who for" UI.

- [ ] **Step 3: Confirm screen**

Show item, source, and the resolved destination(s) with quantities (for multi-PM, list each PM + qty), then a Confirm button that runs the writes above. Reuse existing confirm styling.

- [ ] **Step 4: Compile gate**

Run: `cd ~/inventorypro/apps/mobile && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 5: On-device + e2e verify each destination**

For an item with known stock at "Warehouse":
- **To Location** (Warehouse→Van 1, qty 2): Warehouse −2, Van 1 +2.
- **To PM** (pick a PM who owns a location, qty 1): source −1, PM's location +1.
- **To Job** (qty 1): source −1; appears in active checkouts.
Verify server stock after sync:
```bash
sg docker -c "docker exec infra-postgres-1 psql -U inventorypro -d inventorypro -tAc \"SELECT l.name, s.quantity FROM stock_by_location s JOIN locations l ON l.id=s.location_id WHERE s.item_id='<itemId>' ORDER BY l.name\""
```
Expected: quantities reflect each move; multi-PM splits equal the entered per-PM amounts and the source deduction equals their sum.

- [ ] **Step 6: Checkpoint** — all three destinations adjust stock + log correctly, offline-then-synced.

---

## Task 7: Check In — return to a location

**Files:**
- Modify: `apps/mobile/app/(app)/(checkin)/index.tsx`

**Interfaces:**
- Consumes: `getActiveCheckoutsForUser` (jobs.ts), `getAllLocations` (locations.ts), `adjustStock`, `getStockQuantity` (items.ts), `SearchablePicker` (Task 3), `appendLog`, `appendOutbox`, `useSession`.

- [ ] **Step 1: Return flow**

For each outstanding (job-deployed) checkout, let the user enter a return quantity (≤ the amount out, supporting partial "didn't use it all") and choose a destination location via `SearchablePicker(getAllLocations())`. On confirm:
```typescript
adjustStock(itemId, destLocationId, +returnQty);
const q = getStockQuantity(itemId, destLocationId);
appendOutbox('INSERT', 'stock_by_location', { item_id: itemId, location_id: destLocationId, quantity: q, updated_at: now });
appendLog({ user_id: user.id, team_id: null, action: 'checkin', entity_type: 'item', entity_id: itemId,
  from_location_id: null, to_location_id: destLocationId, quantity: returnQty, unit, job_id: jobId,
  note: null, metadata: null, device_id: null }); // appendLog also enqueues to the outbox (Task 2)
```

- [ ] **Step 2: Compile gate**

Run: `cd ~/inventorypro/apps/mobile && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 3: On-device verify**

Check out an equipment item to a Job (Task 6), then Check In a partial quantity to "Warehouse". Confirm Warehouse stock increased by the returned amount and the activity log shows a `checkin`.

- [ ] **Step 4: Checkpoint** — partial return adds stock at the chosen location + logs `checkin`.

---

## Task 8: Dashboard tile labels & wiring

**Files:**
- Modify: `apps/mobile/app/(app)/(dashboard)/index.tsx`

- [ ] **Step 1: Fix the mis-wired tiles**

- "Add Stock to Location" → already routes to `/(app)/(inventory)/add` (now the combined flow) — keep, confirm label.
- "Transfer Between Areas" currently routes to `/(app)/(locations)` — this is **wrong**. Either remove it (transfers now live under Check Out → To Location) or relabel to "Manage Locations" pointing at `/(app)/(locations)`. Choose relabel to "Manage Locations".
- Confirm "Check Out Item" → `/(app)/(checkout)` and "Check In" → `/(app)/(checkin)` are present.

- [ ] **Step 2: Compile gate**

Run: `cd ~/inventorypro/apps/mobile && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 3: On-device verify**

Dashboard shows correct tiles; each opens the right screen.

- [ ] **Step 4: Checkpoint** — navigation correct end-to-end.

---

## Final verification (whole phase)

- [ ] `npx tsc --noEmit` clean in `apps/mobile` and `apps/api`.
- [ ] Migration 004 applied to prod via the `unraid` skill (`docker compose -f docker-compose.prod.yml up -d --build api` rebuilds with the new SQL; or copy a fresh image tarball). Existing items default to `product`.
- [ ] Walk the loop on-device: Add Stock → item shows stock at a location → Check Out to each destination → Check In a partial → all reflected after sync.
