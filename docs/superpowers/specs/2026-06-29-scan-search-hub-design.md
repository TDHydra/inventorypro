# Scan & Search Hub — Design Spec

**Date:** 2026-06-29
**Status:** Approved design (pending spec review)
**App:** InventoryPro mobile (`apps/mobile`), Expo SDK 56, op-sqlite + outbox/pull sync

## Problem

Three related gaps:

1. **Over-filtered "Manager" picker.** The Checkout destination "Production Manager" field
   only lists users with the exact `production_manager` role, but managers are grouped in
   practice (heads of construction/contents, office/franchise managers all act as
   destinations). It should offer all manager-tier people.
2. **No global search.** Each list screen has its own isolated search bar; there is no way to
   search "everything" (items, equipment, locations, jobs, users) from one place.
3. **Scanning is underused.** A full barcode scanner exists but is only wired to a single
   `scan.tsx` routing screen. Crews want a fast, repeatable scan loop for checking
   consumables in/out and batch-checking-out equipment.

## Goals

- Open the Checkout Manager picker to all manager-tier users.
- Fix latent "empty dropdown" failures in taxonomy pickers.
- Add a dedicated **Scan & Search Hub**: a catalog-style screen with a slide-down search flap
  and a camera icon that launches a continuous scan session.
- Make consumable check-in/out and equipment batch-checkout fast and loopable, ending in a
  detailed receipt.

## Non-goals

- No changes to the underlying sync model, auth, or activity-log rules.
- No new hardware-scanner work (USB scanner path already exists and is untouched).
- Not replacing the existing per-screen search bars (they keep working).

---

## Decisions

### Manager-tier definition
"Manager-tier" = `ROLE_TIER[role] >= 2` (from `src/constants/roles.ts`). That includes:
production_manager, head_of_construction, head_of_contents, carpet_cleaning_manager (tier 2),
office_manager, hr_manager (tier 3), franchise_manager, full_admin (tier 4). Excludes all crew
and temporary employees (tier 1).

### Consumable check-out source (confirmal A — default chosen)
Stock is decremented from the item's **home location**. If the item has no home location, or
zero stock there, the flow prompts for a source location (SearchablePicker over locations with
stock). Check-IN increments the chosen destination/location.

### "Office" destination (confirmal B — default chosen)
"Office" resolves to locations of an office/shop type. If exactly one exists it is
auto-selected; otherwise a typeahead lists them. (Implementation will match on
`location_type` taxonomy label such as `Shop`/`Office`; exact label confirmed during planning.)

---

## Architecture

A single new screen owns search + scan; everything else is small, reusable additions.

```
app/(app)/(hub)/index.tsx        ← new "Scan & Search Hub" screen
  ├─ <SearchFlap/>               ← slide-down/collapse search bar (animated height)
  ├─ camera icon                 ← launches scan session
  └─ catalog list (FlatList)     ← all items/equipment/general, catalog-card style

src/scan/scanSession.ts          ← scan-session state machine (pure logic + types)
src/components/hub/...           ← scan-session UI: In/Out sheet, destination split-buttons,
                                   qty stepper, "Anything else?" prompt, receipt screen
```

The scanner itself (`src/components/BarcodeScanner.tsx`), `getItemByBarcode`,
`getUnitByTag`, the checkout/stock queries, and `SearchablePicker` are **reused unchanged**.

---

## Components

### 1. Field fixes
- **`getManagerTierUsers()`** in `src/db/queries/users.ts`: active users where `ROLE_TIER[role] >= 2`,
  ordered by tier desc then name. Swap the one call site in `app/(app)/(checkout)/index.tsx`
  (currently `getUsersByRole('production_manager')`). Label the picker "Manager" (not
  "Production Manager").
- **Taxonomy empty-picker fallback**: where `getTaxonomyTypes(category)` returns empty, the
  picker shows a fallback (inactive types, or an inline "＋ add type" affordance) instead of an
  empty dropdown. Affects team/job/location/repair-status pickers.

### 2. Scan & Search Hub screen — `app/(app)/(hub)/index.tsx`
- **Top bar:** camera icon + collapsible **SearchFlap** (a small arrow/handle labeled "Search"
  that animates a search `TextInput` open/closed to conserve space).
- **Body:** catalog-style `FlatList` of items + equipment + general, same card/button styling
  as the existing Manage Catalog list. Live-filtered by `searchEverything(q)` when the flap is
  open. Tapping a result routes to its detail screen
  (`/(app)/(inventory|equipment|locations|jobs)/[id]`).
- **Keyboard:** `keyboardShouldPersistTaps="handled"`, list scrolls under the keyboard, nothing
  clipped — matching existing list-screen conventions.
- **Entry point:** a dashboard tile ("Scan & Search"), gated to users with at least one of
  `checkout_inventory` / `checkin_inventory` / `add_inventory`.

### 3. Scan session — `src/scan/scanSession.ts` + `src/components/hub/*`
State machine launched by the camera icon. On each scanned code, classify and branch:

- **Consumable / bulk product** (item found by barcode, `unit_tracked = 0`):
  1. **"Check In or Check Out?"** sheet.
  2. **Check Out:** destination split-buttons **Location ▏Job ▏Manager ▏Office**. Selecting one
     swaps to a typeahead ("Type a Location / Job / Manager…", reusing `SearchablePicker`).
     - Job typeahead with no match → inline "Create this job?".
     - Manager typeahead is fed by `getManagerTierUsers()`.
     - Office resolves per decision B.
     - Source per decision A.
  3. **Check In:** increments the chosen location.
  4. **Quantity stepper** (default 1). Applies the stock adjustment via existing
     `adjustStock(...)` + `appendLog(...)`.
- **Equipment** (code matches an existing `asset_tag`, OR starts with a known item's
  `tag_prefix`): accumulate the unit into the session batch and **immediately reopen the
  camera** to keep scanning. When the user stops, one batched equipment checkout
  (reusing the existing unit-checkout path / `setUnitStatus`).
- **Unknown code:** "Barcode `<code>` not recognized — is it correct?" → "Add as a new item?"
  → opens Quick Add Item with the barcode pre-filled.

**Loop + receipt:** after each completed consumable action (and at the end of an equipment
batch), prompt **"Anything else?"**:
- **Yes** → reopen the camera; the chosen destination is remembered for the next item.
- **No** → a **receipt screen** detailing every action in the session (item, in/out, qty,
  destination, timestamp), with an "Add more" button to resume the session.

### 4. Queries / data — `src/db/queries/*`
- `getManagerTierUsers()` (users.ts).
- `searchEverything(q)` returning grouped results `{ items, equipment, locations, jobs, users }`,
  built from `searchItems`, `getEquipmentModels`, and new lightweight `searchLocations(q)` /
  `searchUsers(q)` / reuse of `searchJobs`.
- A destination resolver mapping `{type, id}` → the stock/log target, including Office.
- Equipment prefix-match helper: given a scanned code, find a matching `asset_tag` or an item
  whose `tag_prefix` is a leading match.
- **Schema:** expected to need **no migration** (barcode, sku, kind, unit_tracked, tag_prefix,
  asset_tag all already exist). Confirmed during planning; if a column is needed, it follows
  `docs/SYNC-MIGRATION-CHECKLIST.md`.

### 5. Permissions
- Hub screen + actions respect existing `checkout_inventory`, `checkin_inventory`,
  `add_inventory`. The "Add as new item" branch requires `add_inventory`/`quick_add`.

---

## Data flow (consumable check-out, happy path)

```
scan code → getItemByBarcode → item (unit_tracked=0)
  → "Check Out"
  → destination = {type: 'job', id} (typeahead)
  → source = item.home_location (decision A)
  → qty = N
  → adjustStock(itemId, sourceLoc, -N); [log] checkout_to_job
  → "Anything else?" → Yes → reopen camera (remember destination)
                     → No  → receipt screen
```

## Error handling
- Camera permission denied → existing BarcodeScanner permission UI.
- Barcode matches nothing → unknown-code branch (verify → add).
- Check-out with insufficient/zero source stock → block with a themed alert, offer to pick a
  different source.
- Offline → all writes go through the existing outbox; receipt reflects local state
  immediately.
- Taxonomy/destination lists empty → fallback affordance (no dead-end dropdown).

## Testing / verification
- `tsc --noEmit` clean (mobile).
- Manager picker in Checkout lists tier≥2 users only; crew/temps excluded.
- Hub: search flap opens/closes; `searchEverything` returns grouped results; result tap routes
  correctly; keyboard never clips the list.
- Scan loop on device: consumable out→job→qty→"anything else?"→receipt; consumable in;
  equipment batch (asset tag + prefix) → single checkout; unknown code → verify → add item.
- Sync round-trip: stock adjustments + new items reach prod via outbox.
- Dev-client hotload after each phase (build debug APK once, Fast-Refresh JS).

## Resolved at spec review (2026-06-29)
- **Office** = locations whose `location_type` label is `Shop` **or** `Office` (match either).
- The Hub adds a **new dashboard tile alongside** the existing Manage Catalog tile; nothing is
  removed.
- Global search lives **only in the Hub**; the existing items-list search bar stays as-is.
