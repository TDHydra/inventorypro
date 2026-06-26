## Task 4 Report: Add Units Flow

### File modified
`apps/mobile/app/(app)/(inventory)/[id].tsx`

---

### Modal structure

A full-screen slide-up `Modal` (animationType="slide") is appended inside
the root `<>` fragment, after the main `KeyboardAvoidingView`. It contains:

1. **Header row** — "Add Units — {item.name}" title + ✕ close button.
2. **Location picker** — `SearchablePicker` over `getAllLocations()` (label=name).
   Pressing "Change" on an already-selected location clears it (sets to null)
   so the input field reappears for a new pick.
3. **Unit rows list** — each row is a `unitFormCard` containing:
   - `BarcodeInput` for asset tag, pre-filled with `item.tag_prefix` on
     open / "+ Add another". The `note` prop shows per-row duplicate errors.
   - `TextInput` for optional serial number.
4. **"+ Add another"** button appends a new empty row (pre-filled with
   `item?.tag_prefix`).
5. **Cancel / Save Units** button pair.

The "+ Add Units" button appears in the view-mode detail screen only when
`item.unit_tracked === 1` and `canAddUnits` (perm `add_inventory`). It is
placed in a "Registered Units" section (between "Stock by location" and
"Photos") that also lists all currently registered units with badge + serial.

---

### Duplicate detection

**In-batch:** `checkTagError(idx, tag, rows)` calls `rows.some((r, i) => i !== idx && r.tag.trim() === t)`. If true → "Duplicate tag in this batch" warning shown inline via `BarcodeInput note` prop.

**Existing DB record:** same helper calls `getUnitByTag(t)` synchronously; if a row is returned → "Tag already registered" warning shown inline.

Detection fires on every keystroke (`updateTag` → `checkTagError` → `setTagErrors`). On save, all filled tags are re-validated and an `Alert` blocks submission if any errors remain.

---

### Per-unit create + outbox

For each row with a non-blank tag:

```
const unitId = generateUUID();
const now = new Date().toISOString();
const unit: EquipmentUnit = { id: unitId, item_id, asset_tag, serial_number,
  status: 'available', current_location_id, current_job_id: null,
  notes: null, created_at: now, updated_at: now, synced_at: null };
upsertUnit(unit);
appendOutbox('INSERT', 'equipment_units', {
  id: unitId, item_id, asset_tag, serial_number, status: 'available',
  current_location_id, current_job_id: null, notes: null,
  created_at: now, updated_at: now,
  // synced_at intentionally NOT included in outbox payload
});
```

Each unit gets its own `generateUUID()` call (`unitId`) — no shared ID.

---

### Single add_units log

After the loop completes, one `appendLog` call:

```
appendLog({
  user_id: user.id, team_id: null, action: 'add_units',
  entity_type: 'item', entity_id: item.id,
  from_location_id: null, to_location_id: locationId,
  quantity: addedTags.length, unit: null, job_id: null,
  note: 'units ' + addedTags.join(','),
  metadata: null, device_id: null,
});
```

`appendLog` self-enqueues to the outbox internally; no separate `appendOutbox`
call is made for the log entry.

---

### tsc result

`npx tsc --noEmit -p tsconfig.json` → exit 0, no output.

Two null-narrowing fixes were needed (TypeScript strict mode does not narrow
state variables across inner closures):
- `openAddUnits`: added `if (!item) return;` guard.
- `addUnitRow`: changed `item.tag_prefix` to `item?.tag_prefix`.
- `saveUnits`: combined `if (!user || !item) return;`.

---

### On-device verification

**Pending human verification.** Requires a physical device or emulator with
the Expo dev client. Tests to perform:
- Open a unit-tracked item. Confirm "+ Add Units" button visible (add_inventory
  perm required; hidden otherwise).
- Open modal; pick a location; enter duplicate tag in row 1 and row 2 →
  confirm inline "Duplicate tag in this batch" warning on row 2 and save blocked.
- Enter a tag that already exists in DB → confirm "Tag already registered" warning.
- Enter valid tags with optional serials; save → confirm units appear in
  "Registered Units" list, outbox has one row per unit (no synced_at field),
  activity_log has one add_units row.
