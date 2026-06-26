## Task 2: Add + edit screens — equipment pieces, Category, Returnable

**Files:**
- Modify `apps/mobile/app/(app)/(inventory)/add.tsx`
- Modify `apps/mobile/app/(app)/(inventory)/[id].tsx`

- [ ] **Step 1: add.tsx — equipment unit lock.** When the create-mode `kind` is `'equipment'`: set `unit_category='piece'` and `unit='each'`, and HIDE the unit-category selector + unit chip row (show a small read-only "Unit: each (piece)" line instead). When `kind='product'`, keep today's unit-category + unit pickers. Wire this off the existing kind toggle so flipping kind updates the unit state.

- [ ] **Step 2: add.tsx — Category field.** Add a `category` state + a `SuggestInput` labeled "Category" with `suggestions={getDistinctValues('category')}` (memoized once), placeholder e.g. "Air Movers, Filters, Equipment Inventory…". Include `category: category.trim() || null` in the new-item `upsertItem` payload AND the `appendOutbox('INSERT','inventory_items',{...})` payload.

- [ ] **Step 3: add.tsx — Returnable toggle.** Add a `returnable` boolean state. Default it from kind: when kind becomes `'equipment'` default `true`, `'product'` default `false` (set on kind change, but let the user override afterward). Render a `Switch` labeled "Returnable? (expected back via Check In)". Include `returnable` in the payloads — local `upsertItem` as `returnable ? 1 : 0`; outbox as the boolean `returnable`.

- [ ] **Step 4: [id].tsx — show + edit.** In view mode, show Category and a "Returnable" / "Consumed" badge. In edit mode, add a Category `SuggestInput` and a Returnable `Switch`; include `category` and `returnable` in the `updateItemFields(...)` call + the `appendOutbox('UPDATE','inventory_items',{...})` payload (send `returnable` as a boolean to the outbox). For equipment items, also apply the same unit lock as the add screen.

- [ ] **Step 5: tsc** exit 0.

- [ ] **Step 6: commit** `feat(inventory): equipment pieces + Category + Returnable on add/edit`. (On-device verification by the human.)

---

