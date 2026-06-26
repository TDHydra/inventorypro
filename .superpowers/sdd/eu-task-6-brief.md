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

