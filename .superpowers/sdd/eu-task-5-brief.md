## Task 5: Item detail — unit roster, repair, derived on-hand

**Files:** modify `apps/mobile/app/(app)/(inventory)/[id].tsx`; create `apps/mobile/src/components/UnitRow.tsx`.

- [ ] **Step 1: derived on-hand.** For a unit-tracked item, compute on-hand from units: replace the `getStockByItem`-based stock section with `countUnitsByStatus(item.id)` → show "N available · M deployed · K in repair" and per-location available counts (group `getUnitsForItem` by `current_location_id` where status='available'). Non-tracked items keep the Phase-1 stock-by-location view.
- [ ] **Step 2: roster.** Render a list of units (a `UnitRow` component: asset tag, status badge, current location/job). Perm-gated (`edit_inventory`) per-unit actions: **Send to repair** (prompt for a note → `setUnitStatus(id,{status:'in_repair', notes})` + outbox + `appendLog action:'repair_out'`), **Return from repair** (pick location → `setUnitStatus(id,{status:'available', current_location_id, notes:null})` + outbox + `appendLog action:'repair_in'`).
- [ ] **Step 3: tsc** exit 0.
- [ ] **Step 4: commit** `feat(equipment): unit roster + repair + derived on-hand`. (On-device by human.)

---

