## Task 3: Item Add/Edit — `unit_tracked` toggle + `tag_prefix`

**Files:** modify `apps/mobile/app/(app)/(inventory)/add.tsx`, `[id].tsx`.

- [ ] **Step 1: add.tsx.** For equipment items only (kind==='equipment'), add a **"Track individual units"** `Switch` (`unitTracked` state) and, when on, a **"Tag prefix"** `TextInput` (`tagPrefix`, placeholder "AM-, DH-, MSC-…"). Include `unit_tracked: unitTracked ? 1 : 0` (local) / boolean (outbox) and `tag_prefix: tagPrefix.trim() || null` in the new-item payloads. When `unitTracked` is on, hide the quantity input + location picker and replace the Save button with a note: "Save the item, then add its units from the item screen." (Units are added in Task 4, not here — keep this screen's create path simple.)
- [ ] **Step 2: [id].tsx.** Edit mode (equipment): same toggle + tag-prefix field; persist via `updateItemFields` (`unit_tracked` number, `tag_prefix`) + outbox UPDATE (`unit_tracked` boolean). View mode shows "Individually tracked" + the prefix when set.
- [ ] **Step 3: tsc** exit 0.
- [ ] **Step 4: commit** `feat(inventory): unit-tracked toggle + tag prefix on add/edit`. (On-device by human.)

---

