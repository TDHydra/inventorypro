# Dev Quick-Add Tool — Design Spec

*Date: 2026-06-26 · Branch: `feat/dev-quick-add` · Program Phase 1 of 4*

## Context

First-time DB population and demo setup are slow through the normal screens (each add is a
multi-step flow). This adds an admin-only **Quick-Add** utility: minimal rapid-entry forms with
"save & add another" for **Items, Locations, Equipment units, and Stock quantities**, each writing
through the normal local-SQLite + outbox path (so records sync to the real backend) plus an
`appendLog` audit row. It also turns the `Settings` stub into a real screen that hosts the tool.

### Decisions locked with the user
1. **Rapid-entry forms** (not bulk auto-generation) — minimal fields, "save & add another", running count.
2. **Admin-gated, in Settings** — gated by the existing `system_settings` permission (tier-4: full_admin / franchise_manager).
3. **Syncs to backend** — normal outbox path; records are real, not throwaway.
4. **Fourth mode: Stock** — pick a location once, then rapidly enter item + quantity pairs ("what's on hand where") — the dumbed-down Add-Stock for initial population.

## Global Constraints (apply to every task)

- **Expo SDK 56** — consult `https://docs.expo.dev/versions/v56.0.0/` before native/API code.
- **op-sqlite bind params** accept only `string | number | null | ArrayBuffer`; booleans `0/1` locally, **real booleans** in outbox payloads.
- **`appendLog(entry)`** self-enqueues its own `activity_log` outbox row — never separately outbox an activity_log row.
- **No new migration, no native module** — reuses existing tables/queries; pure JS/TSX (so this phase ships via Metro/JS, no dev-client rebuild).
- **No new permission** — gate on the existing `system_settings` key; enforce on BOTH the Settings entry and the screen itself (deep-link safe).
- **Reuse existing query helpers** — do not duplicate insert logic.

## Shared Context Pack (authoritative — from the codebase)

- **Items** — `src/db/queries/items.ts`: `InventoryItem` interface; `upsertItem(item: InventoryItem)`;
  `searchItems('', 100)` lists items for a picker; `adjustStock(itemId, locationId, delta)` (adds delta, clamps ≥0);
  `getStockQuantity(itemId, locationId): number`. Item create elsewhere (`add.tsx`) logs `action:'add_stock'`.
- **Locations** — `src/db/queries/locations.ts`: `Location` (now with optional `latitude/longitude`);
  `getAllLocations()`, `getTopLevelLocations()`, `upsertLocation(loc)`. Create logs `location_created`.
- **Equipment** — `src/db/queries/equipmentUnits.ts`: `EquipmentUnit`; `upsertUnit(u)`; `getUnitByTag(tag): EquipmentUnit | null`. Add logs `unit_added`.
- **Outbox** — `appendOutbox(op, table, payload)` from `src/sync/outbox.ts`. INSERT = full upsert; UPDATE = partial. `stock_by_location` conflict key = `(item_id, location_id)`; outbox the **absolute** resulting quantity (read via `getStockQuantity` after `adjustStock`), mirroring `MoveStockModal`.
- **Permission** — `usePermission('system_settings')` (`src/hooks/usePermission.ts`); `system_settings` is true only for tier-4 in `ROLE_DEFAULTS`.
- **Pickers** — `SearchablePicker` (`src/components/SearchablePicker.tsx`), `PickerOption = {id, label, sublabel?}`.
- **Session** — `useSession().user` for `user_id` on logs/created_by.
- **IDs/time** — `generateUUID()` (`src/utils/uuid.ts`); `new Date().toISOString()`.

---

## Architecture (3 units)

### Unit 1 — Settings screen (host)
`app/(app)/(admin)/settings.tsx` — replace the "coming soon" stub with a real (minimal) Settings
screen. Add a **"Developer tools"** section rendered only when `usePermission('system_settings')`,
containing a **Quick Add** row → `router.push('/(app)/(admin)/quick-add')`. Keep the rest minimal
(an app-info line is fine); Phase 3 fills in real settings. Non-admins see Settings without the dev section.

### Unit 2 — Quick-Add screen shell + mode switch
`app/(app)/(admin)/quick-add.tsx` (new) — a screen with a **segmented control**: `Item · Location ·
Equipment · Stock`. Top-of-screen **permission guard**: if `!usePermission('system_settings')`, render
a "Not authorized" view and a back action (deep-link safe). A shared **session counter** ("Added N this
session", per mode) and a shared toast/inline confirmation after each save. Each mode is its own
focused sub-component (Unit 3) to keep the file from growing unwieldy.

### Unit 3 — The four rapid-entry forms (sub-components in the quick-add screen or `src/components/quickadd/`)
Common pattern for all four: minimal required fields, inline validation, a primary **"Save & add
another"** button that (a) writes local + outbox + log, (b) clears the entry fields, (c) keeps
"sticky" selections noted below, (d) refocuses the first field, (e) bumps the counter. A secondary
"Done" returns to Settings. Nothing partial is ever written.

- **Item:** `name` (req); `kind` toggle product/equipment; `unit_category` (default `piece`) + `unit`
  (default `each`); optional `category`; when kind=equipment → `unit_tracked` toggle + `tag_prefix`.
  Build a full `InventoryItem` (id=`generateUUID()`, `active:1`, `updated_at`=now, other fields null/defaults),
  `upsertItem(item)` + `appendOutbox('INSERT','inventory_items', payload)` + `appendLog({action:'item_created',
  entity_type:'item', entity_id:id, user_id, note:name, …nulls})`. Sticky: none.
- **Location:** `name` (req); optional `parent_id` (SearchablePicker of top-level locations); default
  icon/color. `upsertLocation({id, name, parent_id, color, icon, owner_user_id:null, active:1, updated_at:now})`
  + `appendOutbox('INSERT','locations', payload)` (real boolean `active:true`) + `appendLog('location_created')`.
  **Sticky: parent** (add many sub-areas under one parent).
- **Equipment unit:** pick a `unit_tracked` item (SearchablePicker filtered to `unit_tracked=1` from
  `searchItems('',100)`); `asset_tag` (req; reject if `getUnitByTag(tag)` exists — inline "tag already used");
  optional `serial_number`. `upsertUnit({id, item_id, asset_tag, serial_number, status:'available',
  current_location_id:null, current_job_id:null, notes:null, created_at:now, updated_at:now})` +
  `appendOutbox('INSERT','equipment_units', payload)` + `appendLog({action:'add_units', entity_type:'equipment_unit', entity_id:id, note:asset_tag, …})` (reuse the existing `add_units` action).
  **Sticky: item** (add many units of one model).
- **Stock:** pick `location` (SearchablePicker of all locations) and `item` (SearchablePicker), `quantity`
  (numeric, >0). `adjustStock(itemId, locationId, qty)` then read `getStockQuantity(itemId, locationId)`
  for the absolute, `appendOutbox('UPDATE','stock_by_location', {item_id, location_id, quantity:absolute, updated_at:now})`
  + `appendLog({action:'add_stock', entity_type:'item', entity_id:itemId, to_location_id:locationId, quantity:qty, unit:item.unit, user_id, …})`.
  **Sticky: location** (enter all items on hand at one location, fast).

---

## File map

| Unit | Files |
|---|---|
| 1 | `app/(app)/(admin)/settings.tsx` (replace stub) |
| 2+3 | `app/(app)/(admin)/quick-add.tsx` (new; may extract per-mode sub-components into `src/components/quickadd/*.tsx` if the file grows past ~300 lines) |

## Verification
- `tsc --noEmit` clean (mobile). (API untouched; no migration.)
- Manual: as full_admin, Settings shows "Developer tools → Quick Add"; as a crew user it does not, and deep-linking `/(app)/(admin)/quick-add` shows "Not authorized".
- Each mode: "Save & add another" writes a row that appears in the relevant list (Inventory / Locations / item's units / location stock), increments the counter, clears the form, keeps the sticky selection, and the outbox drains to prod (row visible after sync).
- Equipment tag uniqueness rejects a duplicate inline; item kind=equipment reveals unit_tracked/tag_prefix; stock qty ≤0 rejected.

## Out of scope (later phases / backlog)
- Bulk auto-generation of sample data (chose rapid-entry only).
- CSV/paste import.
- Editing/deleting from the quick-add tool (use the normal screens).
- A general Settings screen build-out beyond the dev-tools entry (Phase 3).

## Logging note
`item_created` is the one new action; `location_created`, `add_units`, and `add_stock` reuse existing
vocabulary. Add `item_created` to the shared `ACTION_ICONS` (in `ActivityFeed.tsx`) so the All-Activity
view renders it (small touch, include in the screen work).
