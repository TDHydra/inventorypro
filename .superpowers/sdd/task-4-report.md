# Task 4 Report: Add Stock to Location

## Status: DONE

## What was implemented

Rewrote `apps/mobile/app/(app)/(inventory)/add.tsx` from a "create catalog item" screen into a combined **Add Stock to Location** flow.

### Screen structure

The screen is a single scrollable form with three logical sections:

**1. Item section**
- `SearchablePicker` over all existing items (label=name, sublabel=barcode or kind), sourced from `searchItems('', 100)`. Supports `onCreate` to enter new-item creation mode.
- `BarcodeInput` always visible alongside the picker. On every barcode change, `getItemByBarcode(code)` is called; if a match is found the item is auto-selected in the picker and a read-only card shows name/kind/unit/supplier/model.
- **Add-to-existing mode** (barcode hit or picker selection): a read-only blue card shows the matched item's details. Catalog fields are hidden.
- **Create-new mode** (`onCreate` invoked): editable fields appear: name (pre-filled from the typed query), description, kind toggle (Product / Equipment chips), supplier `SuggestInput`, model `SuggestInput`, unit-category selector, unit chip row, low-stock alert, reorder-to.

**2. Location section**
- `SearchablePicker` over `getAllLocations()` (label=name, sublabel=parent name resolved from the same list).

**3. Quantity section**
- Numeric `TextInput` (decimal-pad).

**Actions:** "Add Stock" primary button, Clear and Cancel secondary links matching the original screen's look.

### Barcode autofill logic

```
barcode changes → useEffect([barcode]):
  code = barcode.trim()
  if !code → clear autofillItem, return
  found = getItemByBarcode(code)
  if found:
    setAutofillItem(found)
    setSelectedItem({ id, label: name, sublabel: barcode|kind })
    setIsCreatingNew(false)
  else:
    setAutofillItem(null)   // barcode may be for a new item being typed in
```

The picker's "Change" tap is detected by checking `selectedItem.id === opt.id` inside `onSelect`; matching clears the selection.

### Save logic (matches brief exactly)

```typescript
const now = new Date().toISOString();
const locationId = selectedLocation.id;
const effectiveUnit = autofillItem?.unit ?? unit;  // existing item's unit wins

let itemId: string;
if (selectedItem) {
  itemId = selectedItem.id;  // existing item path
} else {
  // New catalog item
  itemId = generateUUID();
  const payload = { id, name, barcode, description, sku: null, supplier, model,
                    kind, unit_category, unit, min_qty_alert, reorder_to };
  upsertItem({ ...payload, active: 1, updated_at: now, synced_at: null });
  appendOutbox('INSERT', 'inventory_items', { ...payload, active: true, updated_at: now });
}

adjustStock(itemId, locationId, qty);                          // local +qty
const newQty = getStockQuantity(itemId, locationId);           // absolute
appendOutbox('INSERT', 'stock_by_location',
  { item_id, location_id, quantity: newQty, updated_at: now }); // absolute for server upsert
appendLog({ ..., action: 'add_stock', to_location_id, quantity: qty, unit: effectiveUnit, ... });
// appendLog also enqueues the activity_log row to the outbox (Task 2)
```

Key points:
- `stock_by_location` outbox entry carries the **absolute** post-adjust quantity (from `getStockQuantity`) so the server can upsert keyed on `(item_id, location_id)`.
- New item payload includes `kind` (per spec constraint).
- `active: 1` (number) sent to SQLite; `active: true` (boolean) sent to the JSON outbox — matches the server's Postgres boolean column.
- No booleans or objects passed directly to `executeSync` — all SQLite writes go through query helpers that use `bindParams`.
- `appendLog` handles its own outbox enqueue; no duplicate outbox call for `activity_log`.

## Compile gate

```
cd ~/inventorypro/apps/mobile && npx tsc --noEmit -p tsconfig.json
EXIT: 0  (no errors, no warnings)
```

## Pending verification (human required)

**Steps 3 and 4 of the brief were NOT performed** — they require a physical Android device, USB tunnel, running Metro + API server, and direct Postgres access:

- Step 3: On-device manual test (scan barcode → autofill → pick location → qty 5 → Save → confirm stock visible in item detail)
- Step 4: e2e Postgres confirm that the synced `stock_by_location` row matches the quantity added

These steps must be completed by the human after the physical device is available.
