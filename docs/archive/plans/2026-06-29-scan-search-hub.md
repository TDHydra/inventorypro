# Scan & Search Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Scan & Search Hub (slide-down global search + catalog list + camera-driven continuous scan loop), open the checkout Manager picker to all manager-tier users, and fix empty-taxonomy-dropdown dead-ends.

**Architecture:** One new route group `(hub)` owns the screen; a small set of pure-ish modules under `src/scan/` drive classification and stock writes; new query functions extend existing `src/db/queries/*`. Everything reuses the existing `BarcodeScanner`, `SearchablePicker`, outbox/`appendLog` sync, and checkout stock-move semantics. No schema migration (all columns already exist).

**Tech Stack:** Expo SDK 56, React Native, expo-router (typed routes), op-sqlite (`getDb().executeSync`), outbox push + pull-since sync.

## Global Constraints

- Package manager is **pnpm only** (never npm).
- Typecheck gate per task: `cd /home/tdpotato/inventorypro/apps/mobile && npx tsc --noEmit` → exit 0.
- This working tree is **not a git repo** — skip `git commit` steps; the per-task gate is a clean `tsc --noEmit`. (If a repo gets initialized later, commit per task.)
- Synced writes go through the outbox: booleans as **real booleans** in outbox payloads, stored locally as INTEGER 0/1; **strip local-only `synced_at`** from outbox payloads. Stock changes push as signed `ADJUST` deltas (server merges authoritatively).
- User creation stays online-only (untouched here).
- Mirror existing styles by name rather than inventing new visual language: checkout `forRow`/`forBtn`/`forBtnActive` (split buttons), dashboard `tile`/`tileLabel` (tiles), inventory `searchRow`/`searchBox`/`scanBtn` (search bar + camera button).
- Dev workflow: after each phase builds clean, hotload the debug dev-client via Metro (no rebuild for JS-only changes).
- "Manager-tier" = `ROLE_TIER[role] >= 2` (from `src/constants/roles.ts`).
- "Office" = locations with `type IN ('Shop','Office')`.

---

## File Structure

**New files:**
- `src/db/queries/search.ts` — `searchEverything(q)` unified cross-entity search.
- `src/scan/scanSession.ts` — `classifyScan(raw)` + `ScanClass` types (pure classification).
- `src/scan/stockActions.ts` — `applyConsumableAction(...)` (DRY stock move + log).
- `src/components/hub/SearchFlap.tsx` — animated slide-down search bar.
- `src/components/hub/DestinationPicker.tsx` — Location▏Job▏Manager▏Office split buttons + typeahead.
- `src/components/hub/InOutSheet.tsx` — "Check In or Check Out?" + qty stepper modal.
- `src/components/hub/ScanReceipt.tsx` — session summary list component.
- `app/(app)/(hub)/index.tsx` — the Hub screen (search flap + camera + catalog list + scan session host).

**Modified files:**
- `src/db/queries/users.ts` — add `getManagerTierUsers()`, `searchUsers(q)`.
- `src/db/queries/locations.ts` — add `searchLocations(q)`, `getOfficeLocations()`.
- `src/db/queries/items.ts` — add `findItemByTagPrefix(code)`.
- `app/(app)/(checkout)/index.tsx` — Manager picker uses `getManagerTierUsers()`; relabel "Manager".
- `app/(app)/(teams)/[id].tsx`, `app/(app)/(teams)/index.tsx`, `app/(app)/(jobs)/create.tsx`, `app/(app)/(jobs)/[id].tsx`, `app/(app)/(jobs)/index.tsx`, `app/(app)/(locations)/index.tsx`, `app/(app)/(locations)/[id].tsx`, `app/(app)/(repairs)/[id].tsx` — empty-taxonomy fallback (Task 7, via a shared helper).
- `app/(app)/(dashboard)/index.tsx` — add "Scan & Search" tile.

---

## PHASE 1 — Data layer (no UI)

### Task 1: Manager-tier + user search queries

**Files:**
- Modify: `src/db/queries/users.ts`

**Interfaces:**
- Consumes: `getAllActiveUsers()`, `User`, `rowsAs`, `getDb` (all already in file); `ROLE_TIER` from `../../constants/roles`.
- Produces: `getManagerTierUsers(): User[]`, `searchUsers(q: string, limit?: number): User[]`.

- [ ] **Step 1: Add the import for ROLE_TIER**

At the top of `src/db/queries/users.ts`, the existing line is:
```ts
import { UserRole } from '../../constants/roles';
```
Change it to:
```ts
import { UserRole, ROLE_TIER } from '../../constants/roles';
```

- [ ] **Step 2: Add the two functions** (append near `getUsersByRole`, ~line 188)

```ts
// Active users at manager tier (ROLE_TIER >= 2) — the checkout "Manager"
// destination. Managers are grouped in practice (heads of construction/contents,
// office/franchise managers all act as destinations), so the picker must offer
// all of them, not just production_manager. Ordered by tier desc (most senior
// first) then name.
export function getManagerTierUsers(): User[] {
  return getAllActiveUsers()
    .filter(u => (ROLE_TIER[u.role] ?? 0) >= 2)
    .sort((a, b) => (ROLE_TIER[b.role] - ROLE_TIER[a.role]) || a.name.localeCompare(b.name));
}

// Active users whose name matches the query (case-insensitive), for global search.
export function searchUsers(q: string, limit = 20): User[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM users WHERE active = 1 AND name LIKE ? ORDER BY name LIMIT ?`,
    [`%${q}%`, limit],
  );
  return rowsAs<User>(result.rows);
}
```

- [ ] **Step 3: Typecheck gate**

Run: `cd /home/tdpotato/inventorypro/apps/mobile && npx tsc --noEmit`
Expected: exit 0.

---

### Task 2: Location search + office queries

**Files:**
- Modify: `src/db/queries/locations.ts`

**Interfaces:**
- Consumes: `getDb`, `rowsAs`, `Location` (already in file).
- Produces: `searchLocations(q: string, limit?: number): Location[]`, `getOfficeLocations(): Location[]`.

- [ ] **Step 1: Add both functions** (append after `getShelfLocations`, ~line 161)

```ts
// Active locations whose name matches the query (case-insensitive), for global search.
export function searchLocations(q: string, limit = 20): Location[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM locations WHERE active = 1 AND name LIKE ? ORDER BY name LIMIT ?`,
    [`%${q}%`, limit],
  );
  return rowsAs<Location>(result.rows);
}

// "Office" destinations — locations tagged Shop or Office (the franchise base).
// Backs the scan check-out flow's Office quick-destination.
export function getOfficeLocations(): Location[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM locations WHERE active = 1 AND type IN ('Shop', 'Office') ORDER BY name`,
  );
  return rowsAs<Location>(result.rows);
}
```

- [ ] **Step 2: Typecheck gate**

Run: `cd /home/tdpotato/inventorypro/apps/mobile && npx tsc --noEmit` → exit 0.

---

### Task 3: Equipment prefix match query

**Files:**
- Modify: `src/db/queries/items.ts`

**Interfaces:**
- Consumes: `getDb`, `InventoryItem` (already in file).
- Produces: `findItemByTagPrefix(code: string): InventoryItem | null`.

- [ ] **Step 1: Add the function** (append after `getItemBySku`, ~line 117)

```ts
// Find the equipment item whose tag_prefix is a leading match for a scanned code
// (e.g. 'AM-004' matches an item with tag_prefix 'AM-'). Returns the longest
// matching prefix's item, or null. Lets the scan flow treat prefixed codes as
// equipment even before the specific unit exists.
export function findItemByTagPrefix(code: string): InventoryItem | null {
  const trimmed = code.trim();
  if (!trimmed) return null;
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM inventory_items
     WHERE active = 1 AND kind = 'equipment' AND tag_prefix IS NOT NULL AND tag_prefix != ''
       AND ? LIKE tag_prefix || '%'
     ORDER BY LENGTH(tag_prefix) DESC LIMIT 1`,
    [trimmed],
  );
  return (result.rows[0] as unknown as InventoryItem) ?? null;
}
```

- [ ] **Step 2: Typecheck gate** → exit 0.

---

### Task 4: Unified global search

**Files:**
- Create: `src/db/queries/search.ts`

**Interfaces:**
- Consumes: `searchItems`, `ItemWithTotalStock` (items.ts); `getEquipmentModels`, `EquipmentModel` (equipment.ts); `searchJobs`, `Job` (jobs.ts); `searchLocations`, `Location` (locations.ts — Task 2); `searchUsers`, `User` (users.ts — Task 1).
- Produces: `searchEverything(q: string, perGroup?: number): GlobalSearchResults`, `GlobalSearchResults`.

- [ ] **Step 1: Create the file**

```ts
import { searchItems, type ItemWithTotalStock } from './items';
import { getEquipmentModels, type EquipmentModel } from './equipment';
import { searchJobs } from './jobs';
import type { Job } from './jobs';
import { searchLocations } from './locations';
import type { Location } from './locations';
import { searchUsers } from './users';
import type { User } from './users';

export interface GlobalSearchResults {
  items: ItemWithTotalStock[];
  equipment: EquipmentModel[];
  locations: Location[];
  jobs: Job[];
  users: User[];
}

// One query across every entity, grouped by type. `items` is products only
// (kind='product'); equipment lives in its own group. Empty query → all empty.
export function searchEverything(q: string, perGroup = 10): GlobalSearchResults {
  const query = q.trim();
  if (query.length < 1) {
    return { items: [], equipment: [], locations: [], jobs: [], users: [] };
  }
  return {
    items: searchItems(query, perGroup, 0, undefined, 'product'),
    equipment: getEquipmentModels(query).slice(0, perGroup),
    locations: searchLocations(query, perGroup),
    jobs: searchJobs(query).slice(0, perGroup),
    users: searchUsers(query, perGroup),
  };
}
```

- [ ] **Step 2: Typecheck gate** → exit 0.

---

### Task 5: Scan classification (pure logic)

**Files:**
- Create: `src/scan/scanSession.ts`

**Interfaces:**
- Consumes: `resolveScan` (`./resolveScan`); `getItemById`, `getItemByBarcode`, `findItemByTagPrefix` (Task 3), `InventoryItem` (items.ts); `getUnitByTag`, `EquipmentUnit` (equipmentUnits.ts).
- Produces: `ScanClass`, `classifyScan(raw: string): ScanClass`.

- [ ] **Step 1: Create the file**

```ts
import { resolveScan } from './resolveScan';
import {
  getItemById, getItemByBarcode, findItemByTagPrefix, type InventoryItem,
} from '../db/queries/items';
import { getUnitByTag, type EquipmentUnit } from '../db/queries/equipmentUnits';

export type ScanClass =
  | { kind: 'consumable'; item: InventoryItem }
  | { kind: 'equipment-unit'; unit: EquipmentUnit; item: InventoryItem }
  | { kind: 'equipment-model'; item: InventoryItem }
  | { kind: 'unknown'; code: string };

// Classify a raw scanned string into an actionable category. Resolution order:
//  1. INV:item:/INV:unit: structured codes (resolveScan)
//  2. raw code → existing equipment unit (asset_tag)
//  3. raw code → existing item by barcode
//  4. raw code → equipment model by tag_prefix (new-unit candidate)
//  5. otherwise unknown.
// An item is "consumable" when unit_tracked = 0, else equipment.
export function classifyScan(raw: string): ScanClass {
  const parsed = resolveScan(raw);

  if (parsed?.kind === 'item') {
    const item = getItemById(parsed.id);
    if (item) return item.unit_tracked
      ? { kind: 'equipment-model', item }
      : { kind: 'consumable', item };
  }
  if (parsed?.kind === 'unit') {
    const u = getUnitByTag(parsed.assetTag);
    if (u) {
      const item = getItemById(u.item_id);
      if (item) return { kind: 'equipment-unit', unit: u, item };
    }
  }

  const code = parsed?.kind === 'barcode' ? parsed.code : raw;

  const u = getUnitByTag(code);
  if (u) {
    const item = getItemById(u.item_id);
    if (item) return { kind: 'equipment-unit', unit: u, item };
  }
  const byBarcode = getItemByBarcode(code);
  if (byBarcode) return byBarcode.unit_tracked
    ? { kind: 'equipment-model', item: byBarcode }
    : { kind: 'consumable', item: byBarcode };
  const byPrefix = findItemByTagPrefix(code);
  if (byPrefix) return { kind: 'equipment-model', item: byPrefix };

  return { kind: 'unknown', code };
}
```

- [ ] **Step 2: Typecheck gate** → exit 0.

---

### Task 6: Consumable stock-action helper

**Files:**
- Create: `src/scan/stockActions.ts`

**Interfaces:**
- Consumes: `adjustStock` (items.ts), `appendOutbox` (`../sync/outbox`), `appendLog` (`../db/queries/log`).
- Produces: `ConsumableAction`, `applyConsumableAction(a: ConsumableAction): void`.

> **Before writing**, confirm the check-in action string the rest of the app uses:
> `grep -n "appendLog" /home/tdpotato/inventorypro/apps/mobile/app/\(app\)/\(checkin\)/index.tsx`
> Use that exact `action:` string for the `'in'` direction below (the code uses `'checkin'` as a sensible default — replace if the checkin screen uses a different label such as `'returned'`).

- [ ] **Step 1: Create the file**

```ts
import { adjustStock } from '../db/queries/items';
import { appendOutbox } from '../sync/outbox';
import { appendLog } from '../db/queries/log';

export interface ConsumableAction {
  itemId: string;
  unit: string;
  direction: 'in' | 'out';
  qty: number;
  sourceLocationId: string | null; // required for 'out'
  destLocationId: string | null;   // credited location (location/manager/office); null for job or in
  jobId: string | null;            // set when checking out to a job
  userId: string | null;
  note: string | null;
  coords?: { latitude: number | null; longitude: number | null; accuracy: number | null };
}

// Apply a consumable check-in/out as signed stock deltas (server merges
// authoritatively) + an activity_log row. Mirrors checkout's stockMove/appendLog.
export function applyConsumableAction(a: ConsumableAction): void {
  const stamp = () => new Date().toISOString();

  if (a.direction === 'out') {
    if (a.sourceLocationId) {
      adjustStock(a.itemId, a.sourceLocationId, -a.qty);
      appendOutbox('ADJUST', 'stock_by_location', {
        item_id: a.itemId, location_id: a.sourceLocationId, delta: -a.qty, updated_at: stamp(),
      });
    }
    if (a.destLocationId) {
      adjustStock(a.itemId, a.destLocationId, a.qty);
      appendOutbox('ADJUST', 'stock_by_location', {
        item_id: a.itemId, location_id: a.destLocationId, delta: a.qty, updated_at: stamp(),
      });
    }
  } else {
    const loc = a.destLocationId ?? a.sourceLocationId;
    if (loc) {
      adjustStock(a.itemId, loc, a.qty);
      appendOutbox('ADJUST', 'stock_by_location', {
        item_id: a.itemId, location_id: loc, delta: a.qty, updated_at: stamp(),
      });
    }
  }

  appendLog({
    action: a.direction === 'out' ? (a.jobId ? 'checkout_to_job' : 'transfer') : 'checkin',
    entity_type: 'item', entity_id: a.itemId,
    user_id: a.userId, team_id: null,
    from_location_id: a.direction === 'out' ? a.sourceLocationId : null,
    to_location_id: a.destLocationId,
    quantity: a.qty, unit: a.unit, job_id: a.jobId, note: a.note,
    metadata: null, device_id: null,
    latitude: a.coords?.latitude ?? null,
    longitude: a.coords?.longitude ?? null,
    location_accuracy: a.coords?.accuracy ?? null,
  });
}
```

- [ ] **Step 2: Typecheck gate** → exit 0.

---

## PHASE 2 — Field fixes

### Task 7: Open the checkout Manager picker to manager-tier

**Files:**
- Modify: `app/(app)/(checkout)/index.tsx`

**Interfaces:**
- Consumes: `getManagerTierUsers()` (Task 1).

- [ ] **Step 1: Swap the import**

Existing (line 19):
```ts
import { getUsersByRole } from '../../../src/db/queries/users';
```
Change to:
```ts
import { getManagerTierUsers } from '../../../src/db/queries/users';
```

- [ ] **Step 2: Swap the query** (line ~189)

Existing:
```ts
  // Production managers.
  const pms = useMemo(() => getUsersByRole('production_manager'), []);
```
Change to:
```ts
  // Manager-tier destinations (ROLE_TIER >= 2): heads, production/carpet
  // managers, office/HR/franchise managers — all act as checkout destinations.
  const pms = useMemo(() => getManagerTierUsers(), []);
```

- [ ] **Step 3: Relabel the destination button** (line ~697)

Existing ternary renders `'Manager'` already for `pm`; confirm the empty-state text at line ~749 reads sensibly. Change line 749:
```ts
                {pms.length === 0 && <Text style={s.empty}>No production managers found</Text>}
```
to:
```ts
                {pms.length === 0 && <Text style={s.empty}>No managers found</Text>}
```
And the picker placeholder at line ~755 from `"Pick a production manager..."` to `"Pick a manager..."`.

- [ ] **Step 4: Typecheck gate** → exit 0.

- [ ] **Step 5: On-device check** — Check Out → Destination → Manager: the list now includes heads/office/franchise managers, not just production managers; crew/temps excluded.

---

### Task 8: Empty-taxonomy-dropdown fallback

**Files:**
- Modify: `src/db/queries/taxonomy.ts`
- Modify call sites: `app/(app)/(jobs)/create.tsx`, `app/(app)/(jobs)/[id].tsx`, `app/(app)/(jobs)/index.tsx`, `app/(app)/(teams)/[id].tsx`, `app/(app)/(teams)/index.tsx`, `app/(app)/(locations)/index.tsx`, `app/(app)/(locations)/[id].tsx`, `app/(app)/(repairs)/[id].tsx`

**Interfaces:**
- Produces: `getTaxonomyTypesWithFallback(category, opts?): TaxonomyType[]` — returns active types, or **all** types if the active set is empty (so a fully-deactivated category never yields an empty picker).

- [ ] **Step 1: Add the helper to taxonomy.ts** (after `getTaxonomyTypes`, ~line 278)

```ts
// Like getTaxonomyTypes but never returns an empty list when rows exist: if every
// type in a category has been deactivated, fall back to showing the inactive ones
// so pickers (team/job/location/repair-status) don't become silent dead-ends.
export function getTaxonomyTypesWithFallback(
  category: string,
  opts?: { includeInactive?: boolean },
): TaxonomyType[] {
  const active = getTaxonomyTypes(category, opts);
  if (active.length > 0) return active;
  return getTaxonomyTypes(category, { includeInactive: true });
}
```

- [ ] **Step 2: Route the dropdown-feeding calls through the fallback**

In each listed screen, the picker options are built from one of `getTaxonomyTypes('team'|'job')`, `getLocationTypes()`, or `getRepairStatuses()`. For the **dropdown options** memo only (not icon-rendering lookups), swap to the fallback. Two cases:

(a) Direct `getTaxonomyTypes(category)` calls (teams, jobs) → replace with `getTaxonomyTypesWithFallback(category)`. Add `getTaxonomyTypesWithFallback` to the existing import from `'../../../src/db/queries/taxonomy'`.

(b) Wrapper calls `getLocationTypes()` / `getRepairStatuses()` → add a `fallback` thin wrapper next to them in taxonomy.ts and use it:
```ts
export function getLocationTypesWithFallback(): TaxonomyType[] {
  return getTaxonomyTypesWithFallback(LOCATION_TYPE);
}
export function getRepairStatusesWithFallback(): TaxonomyType[] {
  return getTaxonomyTypesWithFallback(REPAIR_STATUS);
}
```
Then in `locations/index.tsx`, `locations/[id].tsx` (the type **picker** options only — keep the `includeInactive:true` icon lookup at locations/[id].tsx:67 as-is), and `repairs/[id].tsx` status picker, use the `…WithFallback` variant.

> Per-file: find the memo that maps taxonomy rows to picker options (e.g. `getItemTypes`/`getTaxonomyTypes('job')`/`getLocationTypes()`/`getRepairStatuses()`), and only change that options source. Do not change filters that intentionally show active-only chips elsewhere.

- [ ] **Step 3: Typecheck gate** → exit 0.

- [ ] **Step 4: On-device check** — In Manage Types, deactivate every job type, then open job create: the Type picker shows the (inactive) types as a fallback rather than an empty dropdown.

---

## PHASE 3 — Hub screen + scan session UI

### Task 9: SearchFlap component

**Files:**
- Create: `src/components/hub/SearchFlap.tsx`

**Interfaces:**
- Produces: `SearchFlap({ value, onChangeText, open, onToggle }: { value: string; onChangeText: (t: string) => void; open: boolean; onToggle: () => void })`.
- Consumes: `colors` from `../../theme`.

- [ ] **Step 1: Create the component** (animated height reveal; a labeled handle/arrow toggles it)

```tsx
import { useEffect, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, Animated, StyleSheet } from 'react-native';
import { colors } from '../../theme';

interface Props {
  value: string;
  onChangeText: (t: string) => void;
  open: boolean;
  onToggle: () => void;
}

// A collapsible search bar. Collapsed: a thin "Search ▾" handle. Open: a full
// search input + "▴" to collapse. Height animates so it conserves space.
export function SearchFlap({ value, onChangeText, open, onToggle }: Props) {
  const h = useRef(new Animated.Value(open ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(h, { toValue: open ? 1 : 0, duration: 200, useNativeDriver: false }).start();
  }, [open, h]);
  const height = h.interpolate({ inputRange: [0, 1], outputRange: [0, 52] });

  return (
    <View style={s.wrap}>
      <TouchableOpacity style={s.handle} onPress={onToggle} activeOpacity={0.7}>
        <Text style={s.handleText}>🔍 Search</Text>
        <Text style={s.handleArrow}>{open ? '▴' : '▾'}</Text>
      </TouchableOpacity>
      <Animated.View style={[s.barWrap, { height }]}>
        <View style={s.searchBox}>
          <TextInput
            style={s.input}
            placeholder="Search items, equipment, jobs, locations, people…"
            placeholderTextColor={colors.textMuted}
            value={value}
            onChangeText={onChangeText}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
          />
        </View>
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { backgroundColor: colors.background },
  handle: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 8,
  },
  handleText: { fontSize: 14, fontWeight: '700', color: colors.textSecondary },
  handleArrow: { fontSize: 14, color: colors.textSecondary },
  barWrap: { overflow: 'hidden', justifyContent: 'center', paddingHorizontal: 12 },
  searchBox: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface,
    borderRadius: 10, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12,
  },
  input: { flex: 1, height: 42, fontSize: 15, color: colors.textPrimary },
});
```

- [ ] **Step 2: Typecheck gate** → exit 0.

---

### Task 10: DestinationPicker component

**Files:**
- Create: `src/components/hub/DestinationPicker.tsx`

**Interfaces:**
- Produces: `DestinationPicker({ onResolved }: { onResolved: (d: ResolvedDestination | null) => void })` and `ResolvedDestination`.
- Consumes: `SearchablePicker`, `PickerOption` (`../SearchablePicker`); `getOpenJobs`, `upsertJob`, `Job` (jobs.ts); `getManagerTierUsers` (users.ts); `getOfficeLocations`, `getAllLocations`, `getLocationsByOwner`, `Location` (locations.ts); `appendOutbox`, `appendLog`, `generateUUID`, `useSession`, `usePermission`; checkout split-button styles (mirror `forRow`/`forBtn`/`forBtnActive`/`forBtnText`/`forBtnTextActive` from checkout).

```ts
export interface ResolvedDestination {
  type: 'location' | 'job' | 'manager' | 'office';
  label: string;            // human label for the receipt
  toLocationId: string | null; // credited location (null for job)
  jobId: string | null;        // set for job
}
```

- [ ] **Step 1: Create the component**

Behavior:
- Render a 4-button split row (`Location ▏Job ▏Manager ▏Office`) mirroring checkout `forRow`/`forBtn`. Selecting one sets `type` and clears prior selection.
- **Location** → `SearchablePicker` with `searchFn={(q) => searchLocations(q).map(l => ({ id: l.id, label: l.name }))}`; on select → `onResolved({ type:'location', label, toLocationId:id, jobId:null })`.
- **Job** → `SearchablePicker` over `getOpenJobs()` options; `onCreate` (gated on `usePermission('create_jobs')`) creates a job exactly like checkout `createJob` (upsertJob + outbox INSERT with `synced_at` stripped + `appendLog('job_created')`); on select/create → `onResolved({ type:'job', label:name, toLocationId:null, jobId:id })`.
- **Manager** → `SearchablePicker` over `getManagerTierUsers().map(u => ({ id:u.id, label:u.name }))`. On select, resolve the manager's owned locations via `getLocationsByOwner(id)`: if exactly one, `onResolved({ type:'manager', label:`${name} → ${loc.name}`, toLocationId:loc.id, jobId:null })`; if more than one, reveal a second `SearchablePicker` of those locations and resolve on its select; if none, resolve with `toLocationId:null` and label `name` (logged as a manager handoff with no location credit).
- **Office** → `getOfficeLocations()`: if exactly one, immediately `onResolved({ type:'office', label:loc.name, toLocationId:loc.id, jobId:null })`; else a `SearchablePicker` of office locations.
- Call `onResolved(null)` whenever the selection is cleared/incomplete.

Use the exact `createJob` block from `app/(app)/(checkout)/index.tsx:282-302` (copy it; do not import a private function). Reuse the checkout split-button styles by copying the `forRow`/`forBtn`/`forBtnActive`/`forBtnText`/`forBtnTextActive` style rules from checkout's stylesheet into this component's local `StyleSheet.create`.

- [ ] **Step 2: Typecheck gate** → exit 0.

---

### Task 11: InOutSheet component

**Files:**
- Create: `src/components/hub/InOutSheet.tsx`

**Interfaces:**
- Produces: `InOutSheet({ visible, item, onChoose, onClose }: { visible: boolean; item: InventoryItem | null; onChoose: (dir: 'in'|'out', qty: number) => void; onClose: () => void })`.
- Consumes: `ModalSheet` (`../ui/ModalSheet`), `PrimaryButton`, `FilterChip`, `AppInput`, `colors`, `InventoryItem` (items.ts).

- [ ] **Step 1: Create the component**

A `ModalSheet` showing the item name, a **Check In / Check Out** `FilterChip` pair (default Out), a quantity `AppInput` (`keyboardType="decimal-pad"`, default `'1'`), and a `PrimaryButton` "Continue" that parses qty (`parseFloat`, must be > 0) and calls `onChoose(direction, qty)`. Mirror the existing ModalSheet usage in `app/(app)/(inventory)/index.tsx:333-368`.

- [ ] **Step 2: Typecheck gate** → exit 0.

---

### Task 12: ScanReceipt component

**Files:**
- Create: `src/components/hub/ScanReceipt.tsx`

**Interfaces:**
- Produces: `ScanReceiptEntry`, `ScanReceipt({ entries, onAddMore, onDone }: { entries: ScanReceiptEntry[]; onAddMore: () => void; onDone: () => void })`.
- Consumes: `colors`, `PrimaryButton`.

```ts
export interface ScanReceiptEntry {
  id: string;            // generateUUID at creation time
  itemName: string;
  direction: 'in' | 'out';
  qtyLabel: string;      // e.g. "4 gallon" (formatQuantity output)
  destLabel: string;     // e.g. "Job: Smith St" / "Office" / "Shelf A1"
  at: string;            // ISO timestamp
}
```

- [ ] **Step 1: Create the component** — a scrollable list (one card per entry: item, in/out badge, qty, destination, time), plus an "➕ Add more" button (`onAddMore`) and a "Done" button (`onDone`). Mirror checkout `confirmCard`/`confirmRow` styles.

- [ ] **Step 2: Typecheck gate** → exit 0.

---

### Task 13: Hub screen — search + catalog list + scan session host

**Files:**
- Create: `app/(app)/(hub)/index.tsx`

**Interfaces:**
- Consumes: `SearchFlap` (Task 9), `DestinationPicker`+`ResolvedDestination` (Task 10), `InOutSheet` (Task 11), `ScanReceipt`+`ScanReceiptEntry` (Task 12), `classifyScan`+`ScanClass` (Task 5), `applyConsumableAction` (Task 6), `searchEverything`+`GlobalSearchResults` (Task 4), `BarcodeScanner` (`src/components/BarcodeScanner`), `getStockByItem`/`getItemById` (items.ts), `getOpenJobs` (jobs.ts), `formatQuantity` (`src/constants/units`), `useSession`, `usePermission`, `useCurrentPosition`, `generateUUID`, `Alert` (themedAlert), `Stack`/`useRouter`, `colors`.

- [ ] **Step 1: Build the screen scaffold**

State machine (`mode`): `'browse' | 'scanning' | 'inout' | 'destination' | 'receipt'`.
- Header: `Stack.Screen` title "Scan & Search", a camera icon button in `headerRight` that sets `mode='scanning'`.
- Body when `mode==='browse'`:
  - `<SearchFlap value={query} onChangeText={...} open={flapOpen} onToggle={...} />`
  - When `query` non-empty: render grouped `searchEverything(query)` results (sections Items / Equipment / Locations / Jobs / Users) in a `FlatList`/`SectionList`; tapping routes:
    - item → `/(app)/(inventory)/[id]`, equipment → `/(app)/(equipment)/[id]`, location → `/(app)/(locations)/[id]`, job → `/(app)/(jobs)/[id]`, user → `/(app)/(admin)/users` (or user detail if one exists; else users list).
  - When `query` empty: render the catalog list (mirror inventory `index.tsx` list of `searchItems('', …, 'product')` + equipment), same card style — this is the "follows the old Manage Catalog" list.
- Keyboard: wrap scroll/list with `keyboardShouldPersistTaps="handled"`; list scrolls under keyboard (match inventory screen).

- [ ] **Step 2: Wire the scan session**

- `mode==='scanning'` → render `<BarcodeScanner active onScanned={onScan} onClose={() => setMode('browse')} />` full-screen.
- `onScan(raw)`:
  ```ts
  const c = classifyScan(raw);
  if (c.kind === 'unknown') { promptAddNewItem(c.code); return; }       // Task 14
  if (c.kind === 'consumable') { setPendingItem(c.item); setMode('inout'); return; }
  // equipment-unit / equipment-model → batch checkout
  enqueueEquipment(c); // Task 15
  ```
- `mode==='inout'` → `<InOutSheet visible item={pendingItem} onChoose={onInOutChosen} onClose={() => setMode('browse')} />`.
- `onInOutChosen(dir, qty)`: stash `{ item, dir, qty }`; resolve **source** for `'out'` = `pendingItem.home_location_id`; if null or `getStockQuantity(item.id, home) < qty`, set a `needSource` flag so the destination step also asks a source `SearchablePicker` over `getStockByItem(item.id)` rows. Then `setMode('destination')`.
- `mode==='destination'` → `<DestinationPicker onResolved={onDestResolved} />` (+ a source picker when `needSource`). For `'in'`, the destination IS the credited location; hide source.
- `onDestResolved(dest)`: when complete, call:
  ```ts
  applyConsumableAction({
    itemId: item.id, unit: item.unit, direction: dir, qty,
    sourceLocationId: dir === 'out' ? sourceId : null,
    destLocationId: dest.toLocationId,
    jobId: dest.jobId,
    userId: user?.id ?? null,
    note: dest.type === 'manager' ? `Manager: ${dest.label}` : null,
    coords: coords ? { latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy } : undefined,
  });
  pushReceiptEntry({ id: generateUUID(), itemName: item.name, direction: dir,
    qtyLabel: formatQuantity(qty, item.unit, item.unit_category as any),
    destLabel: receiptLabelFor(dir, dest), at: new Date().toISOString() });
  askAnythingElse();
  ```
- `askAnythingElse()` → `Alert.alert('Saved ✓', 'Scan another?', [{ text: 'Yes', onPress: () => setMode('scanning') }, { text: 'No', style: 'cancel', onPress: () => setMode('receipt') }])`.
- `mode==='receipt'` → `<ScanReceipt entries={receipt} onAddMore={() => setMode('scanning')} onDone={() => router.replace('/(app)/(dashboard)')} />`.

- [ ] **Step 3: Permission gate** — at the top, `const canScanAct = usePermission('checkout_inventory') || usePermission('checkin_inventory') || usePermission('add_inventory');` If false, render a "Not authorized" view (mirror `(quickadd)/index.tsx` gate). Browsing/search is allowed for anyone reaching the screen; the camera actions check the relevant permission before writing.

- [ ] **Step 4: Typecheck gate** → exit 0.

---

### Task 14: Unknown-code → verify → add item

**Files:**
- Modify: `app/(app)/(hub)/index.tsx`

- [ ] **Step 1: Implement `promptAddNewItem(code)`**

```ts
function promptAddNewItem(code: string) {
  setMode('browse');
  Alert.alert(
    'Barcode not recognized',
    `Is this barcode correct?\n\n${code}`,
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Add as new item', onPress: () =>
          router.push({ pathname: '/(app)/(quickadd)/item', params: { barcode: code } }) },
    ],
  );
}
```

- [ ] **Step 2: Accept the prefilled barcode in Quick Add Item**

In `src/components/quickadd/ItemQuickAdd.tsx` (and/or `app/(app)/(quickadd)/item.tsx`), read `useLocalSearchParams<{ barcode?: string }>()` and seed the barcode field's initial state with it. Confirm the field exists; if QuickAdd has no barcode field, add a `BarcodeInput` seeded from the param.
> Verify current ItemQuickAdd fields first: `grep -n "barcode" /home/tdpotato/inventorypro/apps/mobile/src/components/quickadd/ItemQuickAdd.tsx`

- [ ] **Step 3: Typecheck gate** → exit 0.

- [ ] **Step 4: On-device check** — scan a made-up code → "not recognized" dialog → "Add as new item" → Quick Add Item opens with the barcode pre-filled.

---

### Task 15: Equipment batch checkout branch

**Files:**
- Modify: `app/(app)/(hub)/index.tsx`

**Interfaces:**
- Consumes: `setUnitStatus`, `getUnitByTag`, `EquipmentUnit` (equipmentUnits.ts); `appendOutbox`; `appendLog`; `DestinationPicker`.

- [ ] **Step 1: Accumulate scanned equipment units**

- Keep `equipBatch: EquipmentUnit[]` state. `enqueueEquipment(c: ScanClass)`:
  - `equipment-unit` → if the unit's `status === 'available'`, push it (dedupe by id); else `Alert.alert('Not available', …)`.
  - `equipment-model` (prefix/barcode matched but no specific unit) → `Alert.alert('Scan a unit tag', 'Scan the asset tag on the specific unit to check it out.')` (we check out existing units, not models).
  - After each push, **immediately reopen the camera** (`setMode('scanning')`) and show a small on-screen count of `equipBatch.length`. Provide a "Done scanning" affordance (e.g. the scanner's close → if `equipBatch.length>0`, go to destination instead of browse).
- When the user finishes (`equipBatch.length>0` and they close the scanner): `setMode('destination')`.

- [ ] **Step 2: Commit the batch on destination resolve**

When `onDestResolved(dest)` runs and `equipBatch.length>0`, for each unit mirror checkout's unit path (`app/(app)/(checkout)/index.tsx:415-455`):
- job dest → `setUnitStatus(id,{status:'deployed',current_job_id:dest.jobId,current_location_id:null})`, outbox the unit (copy checkout `outboxUnit`), `appendLog('checkout_to_job', note:'unit '+asset_tag, job_id:dest.jobId, quantity:1)`.
- location/manager/office dest → `setUnitStatus(id,{status:'available',current_location_id:dest.toLocationId,current_job_id:null})`, outbox, `appendLog('transfer', to_location_id:dest.toLocationId, note:'unit '+asset_tag)`.
Then push one receipt entry summarizing `${n} units → ${dest.label}` and `askAnythingElse()`.

- [ ] **Step 3: Typecheck gate** → exit 0.

- [ ] **Step 4: On-device check** — scan two equipment asset tags (one by `INV:unit:` QR, one by prefix tag); both accumulate; pick a Job destination; both units flip to deployed and appear in the receipt; sync round-trips.

---

### Task 16: Dashboard tile + final verification

**Files:**
- Modify: `app/(app)/(dashboard)/index.tsx`

- [ ] **Step 1: Add the tile** (after the `<QuickAddBanner />`, before the gated primary tiles, ~line 40)

```tsx
        <TouchableOpacity
          style={[styles.tile, styles.tilePrimary]}
          onPress={() => router.push('/(app)/(hub)')}
        >
          <Text style={styles.tileIcon}>🔎</Text>
          <Text style={styles.tileLabelPrimary}>Scan & Search</Text>
          <Text style={styles.tileSubPrimary}>Find anything · scan to check in/out</Text>
        </TouchableOpacity>
```
(Sits alongside Manage Catalog tiles; nothing removed.)

- [ ] **Step 2: Typecheck gate** → exit 0.

- [ ] **Step 3: Full on-device pass**
  - Dashboard → Scan & Search tile opens the hub.
  - SearchFlap toggles open/closed; typing surfaces grouped results; tapping each result type routes correctly; keyboard never clips the list.
  - Empty query shows the catalog list.
  - Camera icon → scan a consumable barcode → In/Out → (Out) destination Location/Job/Manager/Office (+ Office auto-selects when single) → qty → "Scan another?" → No → receipt with the action detailed.
  - Consumable check-in increments the chosen location.
  - Equipment: scan two asset tags → batch → one checkout → receipt.
  - Unknown code → verify → add item with prefilled barcode.
  - Checkout Manager picker lists all manager-tier users.
  - Deactivate all of a taxonomy category → its picker still shows fallback options.
  - Sync round-trip: stock deltas, unit status, new items reach prod.

- [ ] **Step 4: Hotload** — confirm clean `tsc`, then hotload the debug dev-client via Metro for device testing.

---

## Self-Review (completed during authoring)

- **Spec coverage:** Manager-tier (Task 1,7) ✓; taxonomy empty fallback (Task 8) ✓; global search bar/flap (Task 4,9,13) ✓; catalog list (Task 13) ✓; camera icon + scan loop (Task 13) ✓; consumable In/Out + Location|Job|Manager|Office + Office option (Task 10,11,13) ✓; job typeahead + create-if-missing (Task 10) ✓; source default = home location, ask if missing (Task 13 Step 2) ✓; "Anything else?" loop (Task 13) ✓; detailed receipt (Task 12,13) ✓; equipment prefix/asset-tag recognition + batch checkout (Task 3,5,15) ✓; unknown → verify → add (Task 14) ✓; permissions (Task 13 Step 3) ✓; no migration (confirmed — barcode/sku/kind/unit_tracked/tag_prefix/asset_tag/home_location_id all exist) ✓.
- **Placeholder scan:** the two "verify the existing action/field" notes (Task 6 check-in action string; Task 14 ItemQuickAdd barcode field) are concrete greps, not vague TODOs.
- **Type consistency:** `ResolvedDestination`, `ScanClass`, `ConsumableAction`, `GlobalSearchResults`, `ScanReceiptEntry` are defined once and consumed by name; query signatures match the real files read during planning.
