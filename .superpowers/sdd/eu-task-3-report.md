## Task 3 Report — unit_tracked toggle + tag_prefix on add/edit

### What was implemented

**add.tsx**
- Added `unitTracked` (bool, default false) and `tagPrefix` (string, default '') state variables.
- Kind-change `useEffect`: flipping to `product` now resets `unitTracked` and `tagPrefix`, so the toggle only ever applies to equipment.
- `clearForm` resets both new fields.
- `isUnitTrackedNew` derived constant (`isCreatingNew && kind === 'equipment' && unitTracked`) drives all conditional rendering and save logic.
- In the `isCreatingNew` block, after the Returnable switch, added an equipment-only section:
  - "Track individual units" `Switch` bound to `unitTracked`.
  - When ON: a "Tag prefix" `TextInput` (placeholder "AM-, DH-, MSC-…", `autoCapitalize="characters"`).
- When `isUnitTrackedNew` is true: Location picker and Quantity input are hidden via conditional wrappers; "Save the item, then add its units from the item screen." note (blue info box) is shown above the button; button label changes to "Save Item".
- **Stopgap hardcodes replaced:**
  - `upsertItem`: `unit_tracked: unitTracked ? 1 : 0`, `tag_prefix: tagPrefix.trim() || null`
  - `appendOutbox INSERT`: `unit_tracked: unitTracked` (real JS boolean), `tag_prefix: tagPrefix.trim() || null`
- `handleSave` validation: location and quantity checks are gated behind `!isUnitTrackedNew`.
- When `isUnitTrackedNew`: after creating the catalog item, function returns early (no `adjustStock`, no stock_by_location outbox, no appendLog). Shows "Item Created — Open the item screen to add individual units."
- `locationId` moved past the early-return to avoid accessing `.id` on a potentially-null ref.

**[id].tsx**
- Added `editUnitTracked` (bool) and `editTagPrefix` (string) state.
- `startEdit`: initialises from `item.unit_tracked === 1` and `item.tag_prefix ?? ''`.
- Edit form (equipment only): "Track individual units" `Switch` + conditional "Tag prefix" `TextInput` inserted after the Returnable switch.
- `saveEdit`:
  - `fields` includes `unit_tracked: (editUnitTracked ? 1 : 0) as number` and `tag_prefix: editTagPrefix.trim() || null` → `updateItemFields` (SQLite, 0/1 number).
  - `appendOutbox UPDATE` receives `unit_tracked: editUnitTracked` (real boolean) alongside `returnable: editReturnable`.
- View mode: Returnable row gets `s.divider` when the unit-tracked row will follow. New "Unit tracking / Individually tracked [· prefix]" badge row shown only when `item.kind === 'equipment' && !!item.unit_tracked`.

### Boolean vs 0/1 handling
| Destination | unit_tracked type | Why |
|---|---|---|
| SQLite (upsertItem / updateItemFields) | `number` 0 or 1 | op-sqlite binds JS booleans as 0/1 but InventoryItem.unit_tracked is typed `number` |
| outbox INSERT/UPDATE | `boolean` (true/false) | Postgres column is BOOLEAN |

### tsc result
`npx tsc --noEmit -p tsconfig.json` — exit 0, no diagnostics.

### On-device verification
Pending human testing on device. Key flows to exercise:
1. Add screen → create new Equipment item → toggle "Track individual units" ON → verify location/qty hidden, note shown, button reads "Save Item"; save → item created, returns to list.
2. Add screen → toggle OFF (or switch kind to Product) → location/qty/Add Stock button restore normally.
3. Item detail screen (equipment) → Edit → toggle "Track individual units" ON, enter prefix → Save → view mode shows "Individually tracked · <prefix>" badge.
4. Verify outbox rows contain `unit_tracked: true/false` (boolean) not 0/1.
