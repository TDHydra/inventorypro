## Task 4: Add Units flow

**Files:** modify `apps/mobile/app/(app)/(inventory)/[id].tsx` (an "Add Units" modal on the item detail for unit-tracked items). Consumes Task 2 queries + `getAllLocations`, `BarcodeInput`, `generateUUID`, `appendOutbox`, `appendLog`, `useSession`.

- [ ] **Step 1.** On a unit-tracked item's detail, add an **"+ Add Units"** button (perm `add_inventory`) opening a modal: pick a **location** (`SearchablePicker` over `getAllLocations()`), then add unit rows — each row an **asset tag** `BarcodeInput` pre-filled with the item's `tag_prefix` (scannable) + optional serial. "+ Add another" appends a row. Live duplicate-tag detection via `getUnitByTag` (warn/block on an existing tag, and on a dup within the batch).
- [ ] **Step 2: save.** For each row (skip blank tags): `const id=generateUUID(); const now=new Date().toISOString();` build the unit `{ id, item_id: item.id, asset_tag, serial_number: serial||null, status:'available', current_location_id: locationId, current_job_id:null, notes:null, created_at:now, updated_at:now, synced_at:null }`; `upsertUnit(unit)`; `appendOutbox('INSERT','equipment_units', { ...unit (without synced_at), updated_at:now })`. After the batch, one `appendLog({ action:'add_units', entity_type:'item', entity_id:item.id, to_location_id:locationId, quantity: <count>, note:'units '+tags.join(','), ... })`. Refresh the roster.
- [ ] **Step 3: tsc** exit 0.
- [ ] **Step 4: commit** `feat(equipment): Add Units flow`. (On-device by human.)

---

