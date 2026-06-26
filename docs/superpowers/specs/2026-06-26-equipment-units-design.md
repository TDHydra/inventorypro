# Phase 2a — Equipment unit-tracking

*Date: 2026-06-26 · Status: design / awaiting review*

## Context
Phase 1 + 1.5 made equipment count-based (a quantity per location). Some equipment
(air movers, dehus) must be tracked as **individual assets** — you care that unit
**AM-0047** specifically is at Job X and is due for service. This phase adds per-unit
tracking, **opt-in per item**, layered on the existing movement primitives without
disturbing count-based products or non-tracked equipment.

This is **Phase 2a**. Job management (job detail/edit/admin-delete, and gating job
creation to non-crew) is **Phase 2b**, a separate spec. Full maintenance history
(dated repairs, costs, scheduled service) and printable label templates are **later**.

## Decisions (from brainstorming)
1. **Opt-in:** a `unit_tracked` flag on equipment items. Air movers → on; cheap
   filters → off (stay count-based). Products are never unit-tracked.
2. **Asset tags are user-supplied** (existing stickers: `AM-XXXX`, `DH-XXXX`,
   `MSC-XXXX`). No auto-generation yet. An optional per-item **`tag_prefix`**
   (e.g. `AM-`) pre-fills the tag field when adding units so the user just types the
   number; fully editable, scannable.
3. **Units are the source of truth for location** of a unit-tracked item; its
   on-hand at a location = count of its `available` units there. Count-based items
   (products + non-tracked equipment) keep using `stock_by_location` unchanged.
4. **Statuses:** `available | deployed | in_repair | retired`.
5. **Scope now:** units + status + location, unit-level check out/in, basic repair
   (in_repair + note). Deferred: maintenance history, label templates.

## Data model (additive migration 006 — no wipe)

### `inventory_items` (two flags)
- `unit_tracked` — Postgres `BOOLEAN NOT NULL DEFAULT FALSE`; SQLite `INTEGER NOT NULL DEFAULT 0`.
- `tag_prefix` — `TEXT` nullable (e.g. `AM-`).

### `equipment_units` (new)
```
id              uuid pk
item_id         uuid -> inventory_items(id)   -- the equipment "model"
asset_tag       text                          -- user-supplied, unique per system
serial_number   text null
status          text not null default 'available'  -- available|deployed|in_repair|retired
current_location_id uuid null -> locations(id)
current_job_id  uuid null -> jobs(id)
notes           text null
created_at / updated_at  timestamptz
-- (SQLite mirror + synced_at)
```
- `asset_tag` is **unique** (an asset tag identifies one physical unit). Enforce a
  unique index in Postgres; the app detects duplicates before insert.
- A unit's `current_location_id` is its physical home when `available`; when
  `deployed` it carries `current_job_id` (and `current_location_id` may be null).

### Sync
- Register SQLite migration 006 in `loadMigrations()`.
- Add `equipment_units` to `ALLOWED_TABLES` (push), `FULL_TABLES` (full/pull), and a
  pull INSERT template + `rowToValues` mapping (keyed by `id`).
- Add `unit_tracked` + `tag_prefix` to the `inventory_items` interface, `upsertItem`,
  and pull mapping (booleans: 0/1 local, real boolean to the outbox).

## Behaviour

| Item type | On-hand at a location | Check Out | Check In |
|---|---|---|---|
| Product / non-tracked equipment | `stock_by_location` count (Phase 1) | quantity (Phase 1) | quantity (Phase 1) |
| **Unit-tracked equipment** | count of `available` units there (derived) | **pick/scan specific units** | scan units back |

A unit-tracked item never writes `stock_by_location`; its counts derive from units.

## Screens & flows

### A. Item: enable tracking + tag prefix
On Add / Edit (equipment only): a **"Track individual units"** toggle and, when on, a
**Tag prefix** field (e.g. `AM-`). When `unit_tracked` is on, the quantity-based
"Add Stock" path is replaced by **Add Units** for this item (you don't type a count).

### B. Add Units (`(inventory)/units/add` or a modal on item detail)
For a unit-tracked item: choose a **location**, then add one or more units — each row
is an **asset tag** (pre-filled with `tag_prefix`, scannable) + optional serial.
Duplicate-tag detection (warn/block on an existing `asset_tag`). Each saved unit →
`status='available'`, `current_location_id=location`. Writes `equipment_units` rows +
outbox + an `add_units` activity log (entity_type `item`, note carries tags/count).

### C. Item detail → unit roster
For a unit-tracked item, the detail screen shows a **roster**: each unit's asset tag,
status badge, and current location/job. Per-unit actions (perm-gated): **Send to
repair** (status→in_repair + note), **Return from repair** (→available + location),
and the count summary ("8 available · 3 deployed · 1 in repair").

### D. Check Out — unit-tracked items
When the chosen item is `unit_tracked`, the checkout's quantity step becomes a
**unit-selection step**: list `available` units at the source location; pick/scan one
or more. Destinations behave as Phase 1 but mutate each selected unit (not
`stock_by_location`):
- **To Job** → each unit `status='deployed'`, `current_job_id=job`,
  `current_location_id=null`. (Returnable equipment is expected back; non-returnable
  equipment isn't unit-tracked in practice, but if flagged consumed, mark `retired`.)
- **To Location** → `status='available'`, `current_location_id=dest`, `current_job_id=null`.
- **To Production Manager** → `status='available'`, `current_location_id=PM's location`.
Each unit move writes an activity log (same actions as Phase 1: `checkout_to_job` /
`transfer`), `entity_type='item'`, `entity_id=item_id`, `note='unit '+asset_tag`.

### E. Check In — unit-tracked items
Lists this user's deployed units (units with `status='deployed'` whose job checkout
they performed, via the activity log / a `getDeployedUnits` query). Scan/select units
to return → `status='available'`, `current_location_id=chosen location`,
`current_job_id=null`; `checkin` log per unit.

## New/changed queries
- `db/queries/equipmentUnits.ts` (new): `getUnitsForItem(itemId)`,
  `getAvailableUnitsAtLocation(itemId, locationId)`, `getUnitByTag(tag)`,
  `upsertUnit(unit)`, `setUnitStatus(unitId, {status, location_id, job_id, note})`,
  `countUnitsByStatus(itemId)`, `getDeployedUnitsForUser(userId)`.
- `inventory_items`: `unit_tracked`, `tag_prefix` plumbed through interface/upsert/pull.
- Derived on-hand: item detail uses unit counts for `unit_tracked` items instead of
  `getStockByItem`.

## Files (anticipated)
- `apps/api/src/db/migrations/006_equipment_units.sql`
- `apps/mobile/src/db/migrations/006_equipment_units.ts` + register
- `apps/mobile/src/sync/pull.ts` (+ equipment_units, + inventory_items flags)
- `apps/api/src/routes/sync.ts` (ALLOWED_TABLES + FULL_TABLES + equipment_units key)
- `apps/mobile/src/db/queries/equipmentUnits.ts` (new), `items.ts` (flags)
- `apps/mobile/app/(app)/(inventory)/add.tsx`, `[id].tsx` (toggle + roster + Add Units)
- `apps/mobile/app/(app)/(checkout)/index.tsx`, `(checkin)/index.tsx` (unit selection)
- a reusable unit-list/selection component

## Out of scope (later)
Maintenance history (dates/costs/what-was-done), scheduled-service reminders,
auto-generated tags, printable label templates. Phase 2b: job detail/edit/delete +
crew-cannot-create-jobs permission.

## Verification
- Migration 006 applies on populated dev + prod (no wipe); existing items default
  `unit_tracked=false`.
- Toggle an item to unit-tracked → Add Units (AM- prefix pre-fills) → roster shows
  N available at the location; item on-hand = that count.
- Duplicate asset tag is blocked.
- Check Out a specific unit To Job → unit `deployed`, shows in that user's Check In;
  Check In → `available` at chosen location. To Location / PM update the unit's
  location without deploying.
- Repair: send a unit to repair (note) → status in_repair, drops out of available
  counts; return → available.
- All writes offline via outbox; equipment_units sync round-trips through `/sync/push`.
