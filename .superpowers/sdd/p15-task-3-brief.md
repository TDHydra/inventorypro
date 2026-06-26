## Task 3: Check Out To-Job honors `returnable`

**Files:**
- Modify `apps/mobile/app/(app)/(checkout)/index.tsx`

- [ ] **Step 1:** In the To-Job confirm path, read the selected item's returnable flag via `getItemById(selectedItem.id)?.returnable` (it's on the full row after migration 005). Choose the action:
  - `returnable` truthy → keep `action: 'checkout_to_job'` (outstanding; surfaces in Check In via `getActiveCheckoutsForUser`).
  - `returnable` falsy → `action: 'consumed'` (deducts source, does NOT appear in Check In — it's used up).
  In both cases the stock write is identical (source `-qty`, absolute outbox qty); only the log `action` differs. Location and PM destinations are unchanged (`transfer`).

- [ ] **Step 2:** (optional polish) On the confirm screen for a Job destination, label it "Deploy (returnable)" vs "Consume" based on the flag so the user sees which it'll be. Keep minimal.

- [ ] **Step 3: tsc** exit 0.

- [ ] **Step 4: commit** `feat(checkout): To-Job consumes non-returnable items, deploys returnable ones`.

---

