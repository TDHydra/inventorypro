# InventoryPro — Phase 1: Inventory Foundation + Products + Movement

*Date: 2026-06-26*
*Status: design / awaiting review*

## Context

Today "Add Item" only creates a catalog *type* — it never puts physical stock at a
location, so every item shows zero quantity everywhere. The dashboard also has
**Add Stock to Location** and **Transfer Between Areas** tiles that point at the
wrong screens (the catalog form and the locations-management screen). This phase
fixes that and establishes the shared foundation a later **Phase 2 (unit-tracked
equipment)** will build on.

This is **Phase 1 of 2**. Phase 2 (each piece of equipment tracked as an individual
asset with tag/serial, per-unit status, maintenance) is explicitly **out of scope
here** but the schema and flows below are designed so it layers on without rework.

### Domain model

- **Products (consumables)** — chemicals, gloves, sheeting, zip ties. Quantity-based,
  *consumed* when sent to a job (never returned), have reorder/low-stock alerts.
- **Equipment** — air movers, dehumidifiers, scrubbers, meters. Durable, *returnable*
  (goes to a job, comes back). In Phase 1 equipment is tracked **count-based** (e.g.
  "12 air movers in the Warehouse") with returnable behavior; per-unit asset tracking
  is Phase 2.

Both share "lives at a location, gets moved," so they live in one inventory model
distinguished by a `kind` flag, and surface in one inventory view.

## Decisions (resolved during brainstorming)

1. **Add = combined flow.** Adding inventory means "I have N of this item *at* a
   location," creating the catalog entry if the item is new and writing a stock row.
2. **One Check Out button → destination type:** Job, Location, or Production Manager.
   Replaces the old "who for: self / team / office" picker.
3. **Production Manager checkout routes into a location the PM owns.** A PM owns one
   or more locations (locker, vehicle). Checkout to a PM lists *their* locations.
4. **Location ownership is a general primitive** (`locations.owner_user_id`), not a
   PM-specific "van" field — kept vague for reuse.
5. **Multiple PMs:** select several, **enter a quantity per PM**; total checked out
   is the sum.
6. **Equipment depth:** count-based + returnable in Phase 1; unit-tracking is Phase 2.
7. **Keep both "To Location" and "To Production Manager."** They both end up moving
   counts into a location; "To PM" is the by-person shortcut to that PM's locations.
8. **Check In** returns stock to a chosen location — used mainly for returning
   job-deployed equipment (and unused products a crew brings back).

## Cross-cutting: dynamic search & autofill everywhere

Every selection or text entry in these flows must **filter live against existing
database entries as the user types**, narrowing the visible matches down to a tappable
dropdown until there is a single match or none — never a blank field the user has to
fill from memory. This prevents typos and duplicate entries (two "123 Main St" jobs,
"Warehouse" vs "warehouse", a misspelled supplier).

Two reusable patterns, both already in the codebase, applied consistently:

- **Entity pickers** (item, location, destination location, job, production manager):
  a searchable dropdown. As the user types, show matching rows to tap; collapse to the
  single match; when nothing matches and creation is allowed (jobs, new catalog items),
  offer **"Create '<typed text>'"** inline. Jobs in checkout specifically must be
  searchable-and-clickable this way (today's `searchJobs`/`getOpenJobs` feed it).
- **Free-text-from-existing** (supplier, model, unit, and any similar field): the
  existing `SuggestInput` — free text plus tappable chips of existing distinct values
  via `getDistinctValues(...)`.

**Auto-fill on a recognized identifier.** Whenever a typed or scanned value uniquely
matches an existing record, the form **automatically populates every dependent field
from that record** — the user never re-types data the system already has. The primary
case: entering or scanning a **barcode that already exists** instantly fills name,
kind, unit, supplier, model, etc., and the screen switches to "add stock to existing
item" mode (catalog fields collapse to read-only). The same principle applies to any
unique-key match on any form (e.g. selecting an existing job fills its details). This
is automatic and silent — no confirmation needed for a helpful pre-fill.

Where a typed value would instead create a **new** entity, run the existing duplicate
detection (barcode/name) and warn before creating. So the full behavior on every
create/select field is: **match → auto-fill from the existing record; no match →
offer create, with duplicate-warning;** never a blank field the user fills from
memory. This is a requirement for all such fields in these flows, not just jobs.

## Data model changes (additive migration 004 — no wipe)

### `inventory_items.kind`
- `kind TEXT NOT NULL DEFAULT 'product'` — values `'product' | 'equipment'`.
- Postgres: `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'product'`.
- SQLite: `ALTER TABLE inventory_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'product'`.
- Existing rows become `product` (correct default for the current seed's consumables;
  the few equipment rows can be flipped in-app or by a one-off update later).

### `locations.owner_user_id`
- `owner_user_id UUID NULL REFERENCES users(id)` (Postgres) / `TEXT NULL` (SQLite).
- A location may belong to a user. Many locations per user (locker + vehicle).

### Sync
- Register migration 004 in mobile `loadMigrations()`.
- Add `kind` to `inventory_items` handling (interface, `upsertItem`, pull `rowToValues`).
- `locations` already syncs with `*`/dynamic; add `owner_user_id` to the local
  `upsertLocation` + pull mapping. Server `/sync/push` is column-dynamic; confirm
  `owner_user_id` flows. No change to `ALLOWED_TABLES`.

Stock continues to live in `stock_by_location` (counts) for both kinds — Phase 2 adds
a separate `equipment_units` table without disturbing this.

## Behavior by kind (Phase 1)

| Action | Product | Equipment (count-based) |
|---|---|---|
| Add Stock to Location | qty into a location | qty into a location |
| Check Out → Location | relocate counts | relocate counts |
| Check Out → Production Manager | counts into PM's location | counts into PM's location |
| Check Out → Job | **consumed** (deduct from source, logged as used; no expected return) | **deployed** (deduct from source, tracked outstanding; expected back) |
| Check In | optional return of unused | return deployed units to a location |

"To Location" and "To PM" are pure stock relocations for both kinds (no consumption,
no outstanding). Only "To Job" differs: products are consumed, equipment is deployed
and outstanding until checked in.

## Screens & flow

### A. Add Stock to Location (`(inventory)/add.tsx`, repurposed)
1. **Find or create item** — search/scan, or type a barcode. A **recognized barcode
   auto-fills** the item (name, kind, unit, supplier, model, …) and collapses the
   catalog fields to read-only (add-to-existing mode). An unrecognized barcode/name
   reveals the catalog fields (name, barcode, kind toggle product/equipment, unit,
   supplier, model, reorder) to create it inline, with duplicate-warning.
2. **Location** picker (any location, incl. owned ones).
3. **Quantity**.
4. Save → `upsertItem` if new + `adjustStock(item, location, +qty)` + `appendLog`
   (action `add_stock`, to_location, quantity) + outbox.
Keep duplicate-barcode detection → switch to add-to-existing.
Dashboard "Add Stock to Location" tile points here.

### B. Check Out (`(checkout)/index.tsx`, restructured)
Wizard: **Find item → Source location + qty → Destination → Confirm.**
- **Destination buttons:** To Job · To Location · To Production Manager.
- **To Job** — pick/create job (existing). Product = consumed; equipment = deployed
  (outstanding, returnable via Check In).
- **To Location** — pick any destination location → relocate counts.
- **To Production Manager** — modal: "one or more production managers?"
  - Dropdown of `production_manager` users (`getUsersByRole`).
  - One PM → choose which of *their* locations receives it (their owned locations;
    if exactly one, preselect).
  - Multiple PMs → select PMs, **enter a quantity per PM**, each routed to that PM's
    location (their single owned location, or a per-PM location choice if they own
    more than one). Total deducted from source = sum of per-PM quantities.
- **Confirm** → apply `adjustStock` moves (source −, destinations +) + `appendLog`
  per move (action `checkout`/`transfer`, from/to_location, job_id, quantity) + outbox.

### C. Check In (`(checkin)/index.tsx`)
Return stock to a location. Lists outstanding job-deployed checkouts
(`getActiveCheckouts*`); user picks how much came back and the destination location;
applies the reverse stock move + `appendLog` (action `checkin`) + outbox. Partial
returns allowed ("didn't use it all").

### D. Locations (`(locations)/index.tsx`)
Add an optional **"Belongs to (person)"** picker on create/edit (search users). Show
the owner on owned-location cards. No other change to the existing screen.

## New/changed queries & components
- **`SearchablePicker` component** (new, `src/components/`) — the reusable entity
  dropdown described in *Cross-cutting*: props `items`, `value`, `onSelect`, live
  `query` filtering, optional `onCreate(text)` for create-if-no-match. Used for item,
  location, destination location, job, and PM selection so the behavior is identical
  everywhere. (`SuggestInput` stays for free-text-from-existing fields.)
- `getUsersByRole(role)` (mobile `db/queries/users.ts`) — for the PM dropdown.
- `getLocationsByOwner(userId)` (mobile `db/queries/locations.ts`) — PM's locations.
- `inventory_items` interface/`upsertItem`/pull gain `kind`.
- `upsertLocation` + pull gain `owner_user_id`.
- Reuse existing `adjustStock`, `getStockQuantity`, `getStockByItem`, `appendLog`,
  `appendOutbox`, `searchJobs`/`getOpenJobs`/`upsertJob`, `getDistinctValues`.

## Files touched
- `apps/api/src/db/migrations/004_inventory_kind_location_owner.sql`
- `apps/mobile/src/db/migrations/004_inventory_kind_location_owner.ts` + register in `schema.ts`
- `apps/mobile/src/db/queries/items.ts` (kind), `locations.ts` (owner, by-owner), `users.ts` (by-role)
- `apps/mobile/src/sync/pull.ts` (kind, owner_user_id mappings)
- `apps/mobile/src/components/SearchablePicker.tsx` (new reusable entity dropdown)
- `apps/mobile/app/(app)/(inventory)/add.tsx` (combined add-stock)
- `apps/mobile/app/(app)/(checkout)/index.tsx` (destination restructure + PM multi-select)
- `apps/mobile/app/(app)/(checkin)/index.tsx` (return-to-location, confirm partial)
- `apps/mobile/app/(app)/(locations)/index.tsx` (owner picker)
- `apps/mobile/app/(app)/(dashboard)/index.tsx` (tile labels/wiring)

## Out of scope (Phase 2)
Per-unit equipment assets (`equipment_units`: asset tag/serial, status
available/deployed/in-repair, current location/holder), maintenance/repair history,
unit-level scan-to-check-out/in. The `kind` flag and the destination/ownership/
check-in primitives here are the seam Phase 2 attaches to.

## Testing / verification
- Migration 004 applies on a populated DB (no wipe); existing items default to
  `product`; `owner_user_id` nullable.
- Add Stock: new item → catalog row + stock row at location; existing item → stock
  only. Verify via local SQLite and `/sync/push` into Postgres.
- Checkout to each destination adjusts stock correctly and logs the move; PM route
  lands counts in the PM's owned location; multi-PM splits per entered quantity and
  source deduction equals the sum.
- Equipment→Job shows as outstanding; Check In returns it and zeroes the outstanding.
- Product→Job deducts with no outstanding.
- Offline: all writes go through the outbox and reconcile on sync.
- Search/autofill: in checkout, typing in the job field filters existing jobs live to
  a tappable list, collapses to one match, and offers "Create '<text>'" when none
  match; the same dropdown behavior holds for item, location, and PM selection.
- Auto-fill on barcode: scanning/typing an **existing** barcode on the add screen
  fills name/kind/unit/supplier/model from the catalog and switches to add-to-existing
  (read-only catalog fields); an **unknown** barcode opens the create form pre-filled
  with the scanned value.
