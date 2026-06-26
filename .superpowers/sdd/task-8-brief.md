## Task 8: Dashboard tile labels & wiring

**Files:**
- Modify: `apps/mobile/app/(app)/(dashboard)/index.tsx`

- [ ] **Step 1: Fix the mis-wired tiles**

- "Add Stock to Location" → already routes to `/(app)/(inventory)/add` (now the combined flow) — keep, confirm label.
- "Transfer Between Areas" currently routes to `/(app)/(locations)` — this is **wrong**. Either remove it (transfers now live under Check Out → To Location) or relabel to "Manage Locations" pointing at `/(app)/(locations)`. Choose relabel to "Manage Locations".
- Confirm "Check Out Item" → `/(app)/(checkout)` and "Check In" → `/(app)/(checkin)` are present.

- [ ] **Step 2: Compile gate**

Run: `cd ~/inventorypro/apps/mobile && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 3: On-device verify**

Dashboard shows correct tiles; each opens the right screen.

- [ ] **Step 4: Checkpoint** — navigation correct end-to-end.

---

