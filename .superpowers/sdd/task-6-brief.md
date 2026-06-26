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

