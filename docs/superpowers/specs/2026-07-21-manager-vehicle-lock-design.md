# Manager vehicle access & checkout lock — Design

Date: 2026-07-21
Branch: `feature/role-dashboards` (follow-up from #156 device review; extends #157's owner lock)

## Problem

Device review of the role dashboards surfaced two gaps:

1. **Production managers** (tier 2) cannot lock a vehicle from checkout, and their dashboard
   has no Vehicles/Lockers tiles, so they can't reach their team's unit inventory or vehicle
   status controls.
2. **Office/HR/franchise managers** should be able to lock checkout on **any** vehicle.
   Tier-3+ already *has* that power in the predicate (`canLock` = owner-or-tier-3+), but the
   only lock toggle lives inside `VehicleEditSheet`, whose entry button is gated on
   `edit_inventory` — **false for tier 3** — so for office/HR the affordance is unreachable.

Decisions from review: PM scope = **their team's vehicles** (the `getTeamUnits` set: own,
shared team, granted access); vehicles+lockers tiles go to all tier-2 managers including
carpet_cleaning_manager (shared layout); crews already have the tiles; office/HR dashboards
unchanged (they reach vehicles via search / full census).

## Changes

### 1. Shared predicate `canManageVehicle` (new, `src/db/queries/access.ts`)

```ts
canManageVehicle(user, location): boolean
// owner  ||  tier >= 3  ||  (tier >= 2 && sharesTeamWithOwner(user.id, location.owner_user_id))
```

Placed next to `canManageLockerAccess`; reuses the existing `sharesTeamWithOwner` helper.
Replaces the three hand-rolled owner-or-tier-3+ checks:

- `VehicleEditSheet.tsx` — `canLock` seed (line ~56)
- `VehiclePanel.tsx` — `canBypassLock` (line ~111)
- `queries/vehicles.ts` — `isCheckoutLockedFor` (SQL variant: also not-locked when the
  caller is tier ≥ 2 and shares a team with `locations.owner_user_id`)

Result: PM can lock/unlock/bypass on team vehicles; tier-3+ on any vehicle; owner unchanged.

### 2. Lock toggle on `VehiclePanel` (State card)

A "Lock checkout" toggle pill on the full-variant panel, gated by `canManageVehicle` only —
NOT by `edit_inventory` — writing `checkout_locked` via `upsertVehicleState` (same write the
edit sheet does). This is what makes the power reachable for office/HR. The edit-sheet toggle
stays, now using the same predicate.

### 3. Dashboards (`src/dashboard/roleLayouts.ts`)

Append to `TIER2_MANAGER_LAYOUT` (matching the crew layout's placement):

```ts
{ widget: 'vehicles', width: 'half' },
{ widget: 'lockers',  width: 'half' },
```

Covers production_manager, head_of_construction, head_of_contents, carpet_cleaning_manager.
CREW_LAYOUT already has both tiles — verify-only. Office/HR/admin layouts unchanged.

### 4. Explicitly no change

- Team unit-inventory visibility for PMs already works (#162 `sharesTeamWithOwner` path) — verify-only.
- Tank/status editing for PMs already works (`edit_inventory` true at tier 2).
- No server or schema changes: #157's lock is client-enforced by design; this extends the
  same client predicate. JS-only → hotload, no rebuild.

## Testing

- Unit (`access.test.ts` or alongside existing query tests): `canManageVehicle` truth table —
  owner tier-1 ✓, PM same-team ✓, PM other-team ✗, tier-3 non-team ✓, crew non-owner ✗.
- Unit: `isCheckoutLockedFor` gains PM same-team (false) / PM other-team (true) cases.
- Device (hotload): PM login → dashboard shows Vehicles/Lockers tiles → team vehicle → edit
  tanks, toggle lock; crew login → locked team vehicle shows disabled checkout; office
  manager → any vehicle → lock pill visible on panel, no edit pencil.
