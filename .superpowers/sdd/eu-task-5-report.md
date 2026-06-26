## Task 5 Report — Unit Roster, Repair, Derived On-Hand

### Step 1: Derived On-Hand (unit-tracked items)

`countUnitsByStatus(item.id)` is called at init and after every `reload()`. For `unit_tracked === 1` items the top card's "on hand" number comes from `unitCounts.available`; the "Units on Hand" section below shows the summary line "N available · M deployed · K in repair" (deployed/in_repair terms are suppressed if zero). Per-location available counts are derived by iterating `getUnitsForItem` filtered to `status='available' && current_location_id != null`, grouped by `current_location_id`, with names resolved from a `locationMap` built from `locationOptions`. Non-tracked items continue to use the existing `getStockByItem` / "Stock by location" section unchanged.

### Step 2: UnitRow Component (`apps/mobile/src/components/UnitRow.tsx`)

Props: `{ unit: EquipmentUnit; locationName?: string | null; onRepairOut?: () => void; onRepairIn?: () => void }`.

Renders: asset tag + optional serial (S/N: …) + optional location name in the info column; status badge with colour-coded background (available=green `#D1FAE5/#065F46`, deployed=blue `#DBEAFE/#1D4ED8`, in_repair=amber `#FEF3C7/#92400E`, retired=grey `#F1F5F9/#64748B`) in the right column; and action buttons only when the corresponding handler is provided.

### Step 3: Roster + Repair Actions

**Send to Repair** (shown for `status === 'available' || 'deployed'`, gated by `canEdit`):
- Opens a cross-platform note Modal (a transparent overlay with a card containing a TextInput). `Alert.prompt` was not used because it is iOS-only; a small Modal was used instead.
- On confirm: `setUnitStatus(unit.id, { status: 'in_repair', notes: note || null })` → `appendOutbox('UPDATE', 'equipment_units', <returned row minus synced_at>)` → `appendLog({ action: 'repair_out', entity_type: 'item', entity_id: item.id, note: 'unit ' + asset_tag + (note ? ': ' + note : ''), ... })`.

**Return from Repair** (shown for `status === 'in_repair'`, gated by `canEdit`):
- Opens a full-sheet Modal with `SearchablePicker` for location selection (same pattern as Add Units modal).
- On confirm: `setUnitStatus(unit.id, { status: 'available', current_location_id: locId, notes: null })` → `appendOutbox('UPDATE', 'equipment_units', <returned row minus synced_at>)` → `appendLog({ action: 'repair_in', ..., to_location_id: locId, note: 'unit ' + asset_tag, ... })`.

Both paths call `reload()` at the end which refreshes `units`, `stock`, and `unitCounts`.

### tsc Result

`npx tsc --noEmit -p tsconfig.json` — exit 0, no output (clean).

### On-Device

Pending human verification on device.

### Concerns

- **Alert.prompt not used**: replaced with a custom transparent Modal overlay containing a TextInput. This is more reliable cross-platform (Android does not support Alert.prompt).
- **`synced_at` absent from outbox**: confirmed omitted from all `appendOutbox('INSERT', 'equipment_units', ...)` payloads in both `doRepairOut` and `doRepairIn`.
- **appendLog self-enqueues**: no separate `appendOutbox` call for `activity_log` rows.
- **"on hand" for unit-tracked items** uses `unitCounts.available` only (units at a location, ready to use). Deployed + in_repair units are shown in the summary line below but do not inflate the "on hand" number.

## Post-Review Fixes (Commit b9c4d36)

**Fix 1 (Important): Repair outbox operation verb**
- Changed both `doRepairOut` and `doRepairIn` to use `appendOutbox('INSERT', 'equipment_units', ...)` instead of `'UPDATE'`
- Rationale: equipment_units is keyed by `id` and the server applies INSERT as a full upsert (ON CONFLICT(id) DO UPDATE), matching the app's pattern for full-row sync and ensuring idempotence/order-safety
- Grep output:
  ```
  248:      appendOutbox('INSERT', 'equipment_units', {
  288:    appendOutbox('INSERT', 'equipment_units', {
  310:    appendOutbox('INSERT', 'equipment_units', {
  ```

**Fix 2 (Minor): Repair-in location picker toggle**
- Updated `SearchablePicker` `onSelect` callback in the repair-in Modal from toggle-on-non-null to intuitive replace logic
- Changed: `if (repairInLoc !== null) setRepairInLoc(null); else setRepairInLoc(opt);`
- To: `setRepairInLoc(prev => (prev?.id === opt.id ? null : opt));`
- Effect: tapping the same location now deselects it, tapping a different location replaces it (no double-tap required)

**Verification**
- `tsc --noEmit -p tsconfig.json` exit 0 (clean)
- All 3 equipment_units appendOutbox calls confirmed as INSERT
