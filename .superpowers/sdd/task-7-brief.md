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

