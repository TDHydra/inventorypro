## Task 5 Report: Locations owner picker

### What changed

**File modified:** `apps/mobile/app/(app)/(locations)/index.tsx`

**Imports added:**
- `getAllActiveUsers` from `src/db/queries/users`
- `ROLE_DISPLAY_NAMES` from `src/constants/roles`
- `SearchablePicker`, `PickerOption` from `src/components/SearchablePicker`

**State added:**
- `ownerOption: PickerOption | null` (default null)
- Reset to null in `resetForm()` (called on Clear, Cancel, and after successful create)

**New useMemos:**
- `allUsers` — snapshot of active users fetched once at mount
- `userOptions` — mapped to `PickerOption[]` with `label=name`, `sublabel=ROLE_DISPLAY_NAMES[role]`
- `userMap` — `Map<string, string>` of `id → name` for card display

**`doCreate()` payload update:**
- `owner_user_id: ownerOption?.id ?? null` included in the `payload` object
- Both `upsertLocation({ ...payload, synced_at: null })` and `appendOutbox('INSERT', 'locations', payload)` carry the owner field
- Removed the hardcoded `owner_user_id: null`

**Modal:** A `SearchablePicker` labeled "Belongs to (optional)" added between the Inside chip-row and the Icon grid. Tapping "Change" on a selected owner clears the selection (toggles back to search mode).

**Card display:** Both top-level and child location cards show `Owner: <name>` (11px, #64748B) when `owner_user_id` is set, resolved via `userMap`. Falls back to raw UUID if the user is not in the active list.

### TypeScript compile gate

```
cd ~/inventorypro/apps/mobile && npx tsc --noEmit -p tsconfig.json
```
Exit code: **0** — no errors.

### On-device + Postgres e2e (pending)

Steps 3 and 4 from the brief require a connected phone and running Postgres. These must be executed by the human developer:

1. Open the app on device, tap "+ New", fill in name (e.g. "Pete's Van"), select an owner, tap Add Location.
2. Verify the card shows `Owner: <name>`.
3. After sync, confirm in Postgres:
   ```sql
   SELECT name, owner_user_id IS NOT NULL AS owned
   FROM locations
   WHERE name = 'Pete''s Van';
   ```
   Expected: `Pete's Van|t`
