# Vehicles UI wave 1 — #152 debris + #155 open checkout + #167 lock hierarchy

**Date:** 2026-07-25. Approved in-session after brainstorm.
Builds on schema phase 0 (`docs/superpowers/specs/2026-07-23-vehicles-schema-phase0-design.md`,
merged at `70d2fca`). **No migrations in this wave** — every column already exists in all
three stores (mobile 053/054, API 065/066). Wave 2 (#168 gas receipts) is a separate
branch/spec.

## Decisions made during brainstorm

| Question | Decision |
|---|---|
| Work structure | Two waves: #152+#155+#167 on `vehicles-ui-wave1`, then #168 alone |
| Debris granularity | Drag is visually continuous, committed value snaps to 10s (0–100) |
| `open_checkout` toggle placement | VehicleEditSheet only (deliberate action; no panel pill) |
| Owners without `edit_inventory` | Edit link opens for owner too; non-editors see only lock + open_checkout rows |
| Unavailable vehicles in list | New **Available** segment (Team / All / Available); panel button disables with reason |
| Lock teeth (#167) | Checkout **bypass follows unlock**: a higher-tier lock blocks even the owner from checking out |

## 1. #152 — Debris option + level selector

- **Conditional tanks:** hiding water/waste controls without a truck mount already shipped
  (#159) in VehiclePanel (status pills + State rows). Verify `VehicleInlineStatus` and any
  other tank surface honors the same rule; no new work expected.
- **`debris_option` toggle (0/1):** tap-pill in `VehicleEditSheet` directly under the
  truck-mount pill (identical Pressable+StatusPill pattern), and the same pill in
  `VehicleQuickAdd` for creation parity. Written via `upsertVehicleState`.
- **New kit component `VerticalLevelSlider`** (`src/components/ui/`):
  - PanResponder-based (precedent: `DragList`) — web-safe, zero new dependencies.
  - Vertical track ≈140 px, fill grows from the bottom, % label.
  - Drag updates the fill continuously; on release the value **snaps to the nearest 10**
    and fires `onCommit(value: number)`. No writes during the drag.
  - Props: `value`, `onCommit`, `disabled` (maintenance mode renders read-only, mirroring
    the tank segments' `locked` fallback).
- **VehiclePanel State card:** when `debris_option = 1`, a "Debris level" `FieldLabel` +
  slider row (below the tank rows; independent of truck mount). Commit writes
  `upsertVehicleState(locationId, { debris_level }, userId)` — ungated, like tanks.
- **Status pill:** when the option is on, `Debris {n}%` — tone `warning` at ≥ 80,
  `neutral` below. Appears in both panel variants via the shared pill row.

## 2. #155 — Role-free, owner-aware checkout availability

- **Availability predicate** — new pure helper in `vehicleSessionLogic.ts` (unit-tested
  beside `resolveCheckoutAction`):
  - *Available* ⇔ no open session AND (no owner OR `open_checkout = 1` OR caller is owner).
  - Otherwise returns a reason: `checked_out` | `owned_closed`.
  - Locking (#167) composes on top via `isCheckoutLockedFor`; a locked vehicle is
    unavailable with reason `locked` at the UI layer.
- **VehiclePanel button:**
  - The `checkout_inventory` permission gate is **removed for the vehicle checkout button
    only** (rule 1: role never gates vehicle checkout). Inventory checkout is untouched.
  - States: available → **Check Out**; own open session → **Check In**; held by someone
    else but otherwise available to caller → existing **Take Over** (destructive confirm;
    rule 2 bars *concurrent* sessions, takeover closes the other session first);
    `owned_closed` → disabled **"Owned by <name>"**; lock not liftable by caller →
    disabled **"🔒 Locked by <name>"**.
- **Vehicles list (`(vehicles)/index.tsx`):** third segment **Available** on the existing
  SegmentedControl — lists exactly the set the caller could check out right now
  (availability predicate + not locked-for-caller). Team/All behavior and defaults
  unchanged.
- **`open_checkout` toggle:** row in `VehicleEditSheet` only. Shown only when the vehicle
  has an owner; gated `canManageVehicle` (same as the lock row). Pill wording distinct
  from the lock's: **"Anyone can check out" / "Owner-only"**. Written via
  `upsertVehicleState` inside the existing save transaction.
- **Edit-sheet access:** panel Edit link shows for `edit_inventory` **or** the owner.
  Non-editors get a reduced sheet: only the rows they may write (checkout lock,
  open_checkout); name/model/truck-mount hidden and the location-rename path skipped in
  `handleSave`.
- **Server-side:** no API change expected — `vehicle_checkouts` INSERT is already
  role-free (verified 2026-07-25; only UPDATE has holder/close-only rules). Plan-time
  verification task: the vehicles-table push guard must cover `open_checkout` writes the
  same way it covers `checkout_locked` (owner/manager only); add the guard if phase 0
  didn't.

## 3. #167 — Lock hierarchy

- **New shared predicate** in `src/db/queries/access.ts` beside `canManageVehicle`:
  caller may **lift** a lock ⇔ `canManageVehicle` AND
  (`locked_by IS NULL` (legacy) OR `locked_by = caller` OR
  `ROLE_TIER[caller] ≥ ROLE_TIER[locker's current role]`).
  A deleted locker resolves to tier 0 (anyone who can manage may unlock).
- **Bypass follows unlock:** `isCheckoutLockedFor` (queries/vehicles.ts) gains the same
  tier comparison — a lock set by a higher tier blocks **everyone** who cannot lift it,
  including the owner. ⚠️ The SQL there duplicates the TS predicate logic
  (queries/access.ts:341 ↔ queries/vehicles.ts:336 area); both sites change together and
  the tests pin them to each other.
- **Stamping:** locking stamps `locked_by` via `resolveLockStamp` (phase-0 wiring);
  unlocking clears it to NULL. Both writers (panel pill, edit sheet) go through the same
  path.
- **UI:**
  - Status-pill row and State-card pill: **"🔒 Locked by <name>"** (`getUserById(locked_by)`);
    legacy NULL → plain "🔒 Locked".
  - State-card pill is interactive only when the caller may flip it in that direction
    (lock: `canManageVehicle`; unlock: lift predicate). Not liftable → pill renders
    without the "tap to toggle" hint.
  - Edit-sheet lock row: read-only display when the caller may not lift the existing lock.
- Hard guards (`checkOutVehicle`/`takeOverVehicle`) keep throwing through
  `isCheckoutLockedFor`, now stricter.

## 4. Testing & verification

- `vehicleSessionLogic.test.ts`: availability matrix (owner/unowned/opted-in ×
  checked-out/free) and slider snap helper if extracted.
- Access tests: lift-lock predicate tiers (self-lock, legacy NULL, equal tier, higher
  locker, deleted locker) and `isCheckoutLockedFor` parity cases.
- Full mobile + API suites and `tsc` green before merge (phase-0 baseline: 574 / 417).
- Device hotload verify after the phase (CLAUDE.md): debris drag on device, Available
  segment, owner-blocked checkout wording, tiered unlock. Web sanity check of the
  PanResponder slider (Expo Web).
- Board: #152/#155/#167 stay In progress until device-verified, then Done via board skill.

## Out of scope (wave 2+)

- #168 gas receipts (form, payer settings screen, media) — own branch and spec.
- The lock-button reactivity/revert bug noted in #167 — separate investigation if it
  reproduces after this wave (may have been the reactive-cache class of issue).
