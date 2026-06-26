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

