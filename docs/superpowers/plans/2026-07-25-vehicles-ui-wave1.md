# Vehicles UI Wave 1 (#152 debris + #155 open checkout + #167 lock hierarchy) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Session directive (2026-07-23):** this wave is implemented TOGETHER in the main session — use superpowers:executing-plans inline; subagents only for research/docs.

**Goal:** Ship the UI for the three phase-0 vehicle columns: debris option + drag-to-fill level (#152), role-free owner-aware checkout availability (#155), and the tiered lock hierarchy (#167).

**Architecture:** All business rules land as pure functions in `vehicleSessionLogic.ts` (node:test, TDD), consumed by the DB layer (`queries/vehicles.ts`, `queries/access.ts`) and three UI surfaces (VehiclePanel, VehicleEditSheet, vehicles list). One new generic kit component (`VerticalLevelSlider`, PanResponder). **No migrations** — phase 0 (merged @ 70d2fca) shipped every column in all three stores.

**Tech Stack:** Expo SDK 56 / React Native, op-sqlite (mobile), node:test + tsx for pure-logic tests, PanResponder (web-safe, precedent `ui/DragList.tsx`).

**Spec:** `docs/superpowers/specs/2026-07-25-vehicles-ui-wave1-design.md` (all six brainstorm decisions in its table).

## Global Constraints

- **No migrations in this wave.** If you think you need one, stop — phase 0 already added `debris_option`, `debris_level`, `open_checkout`, `locked_by`, and the schema.web.ts twins.
- **Server side is deliberately untouched.** `syncPolicy.ts` has `vehicles: { INSERT: null, UPDATE: null }` — the whole vehicles table is ungated by design (crew-level state writes). There is NO existing server guard for `checkout_locked` to mirror; #167 enforcement is client-side like #157/#165 today. A follow-up board item covers a server guard (Task 10).
- **Reuse the kit** (user directive): StatusPill, FieldLabel, SegmentedControl, PrimaryButton, EntityEditSheet, confirmSheet. No hand-rolled surfaces.
- **Never `git add -A`** — `.claude/skills/board/*` modifications and `.claude/skills/start-metro/` are deliberate dirty state. Stage exact paths only.
- **Branch first**: Metro serves the main checkout; all work on `vehicles-ui-wave1`.
- Copy strings verbatim from tasks: button labels `Owned by <name>` / `🔒 Locked by <name>`, pills `Anyone can check out` / `Owner-only`, segment `Available`.
- Working directory for mobile commands: `apps/mobile`. Mobile suite: `pnpm test` (574 baseline). Typecheck: `pnpm exec tsc --noEmit`.
- Commit messages: `feat(#NNN): ...` + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.

---

### Task 0: Branch setup

**Files:** none (git only)

- [ ] **Step 1: Push main, create the branch**

```bash
cd /home/tdpotato/projects/InventoryPro
git fetch origin && git status   # confirm on main, clean apart from the known .claude/skills dirty files
git push origin main             # main is ~12 commits ahead (incl. spec a724de7)
git checkout -b vehicles-ui-wave1
```

Expected: push succeeds (re-fetch first — parallel sessions have moved remote main before); branch created.

---

### Task 1: Pure logic — availability, lock-lift, debris snap (TDD)

**Files:**
- Modify: `apps/mobile/src/components/vehicles/vehicleSessionLogic.ts` (append after `resolveLockStamp`)
- Test: `apps/mobile/src/components/vehicles/vehicleSessionLogic.test.ts` (append)

**Interfaces:**
- Consumes: nothing new (module already has zero RN/DB imports — keep it that way; `ROLE_TIER` is NOT imported here, callers pass numeric tiers).
- Produces (later tasks call these exact signatures):
  - `resolveVehicleAvailability(input: { ownerUserId: string | null; openCheckout: number; hasOpenSession: boolean; userId: string | null }): VehicleAvailability` where `VehicleAvailability = { available: boolean; reason: 'checked_out' | 'owned_closed' | null }`
  - `canLiftVehicleLock(input: { canManage: boolean; lockedBy: string | null; lockerTier: number; userId: string | null; userTier: number }): boolean`
  - `snapDebrisLevel(raw: number): number`

- [ ] **Step 1: Write the failing tests** — append to `vehicleSessionLogic.test.ts` (extend the existing import block with the three new names):

```ts
// ── #155: availability ───────────────────────────────────────────────────────
test('availability: open session wins over everything → checked_out', () => {
  assert.deepEqual(
    resolveVehicleAvailability({ ownerUserId: 'me', openCheckout: 1, hasOpenSession: true, userId: 'me' }),
    { available: false, reason: 'checked_out' },
  );
});

test('availability: unowned + free → available', () => {
  assert.deepEqual(
    resolveVehicleAvailability({ ownerUserId: null, openCheckout: 0, hasOpenSession: false, userId: 'me' }),
    { available: true, reason: null },
  );
});

test('availability: owned, closed, not mine → owned_closed', () => {
  assert.deepEqual(
    resolveVehicleAvailability({ ownerUserId: 'frank', openCheckout: 0, hasOpenSession: false, userId: 'me' }),
    { available: false, reason: 'owned_closed' },
  );
});

test('availability: owned but opted in → available', () => {
  assert.deepEqual(
    resolveVehicleAvailability({ ownerUserId: 'frank', openCheckout: 1, hasOpenSession: false, userId: 'me' }),
    { available: true, reason: null },
  );
});

test('availability: my own vehicle is always available to me when free', () => {
  assert.deepEqual(
    resolveVehicleAvailability({ ownerUserId: 'me', openCheckout: 0, hasOpenSession: false, userId: 'me' }),
    { available: true, reason: null },
  );
});

test('availability: anonymous user does not match a null owner', () => {
  assert.deepEqual(
    resolveVehicleAvailability({ ownerUserId: 'frank', openCheckout: 0, hasOpenSession: false, userId: null }),
    { available: false, reason: 'owned_closed' },
  );
});

// ── #167: lock lift (tiers: 1 crew / 2 PM / 3 office / 4 admin) ─────────────
const lift = (over: Partial<Parameters<typeof canLiftVehicleLock>[0]>) =>
  canLiftVehicleLock({ canManage: true, lockedBy: 'pm', lockerTier: 2, userId: 'me', userTier: 1, ...over });

test('lift: no manage authority → never', () => {
  assert.equal(lift({ canManage: false, userTier: 4 }), false);
});

test('lift: legacy NULL locker → any manager may lift', () => {
  assert.equal(lift({ lockedBy: null, lockerTier: 0 }), true);
});

test('lift: self-lock → may lift regardless of tier', () => {
  assert.equal(lift({ lockedBy: 'me', lockerTier: 4, userTier: 1 }), true);
});

test('lift: crew owner vs PM lock → blocked (the #167 case)', () => {
  assert.equal(lift({ userTier: 1, lockerTier: 2 }), false);
});

test('lift: equal tier → allowed', () => {
  assert.equal(lift({ userTier: 2, lockerTier: 2 }), true);
});

test('lift: higher tier → allowed', () => {
  assert.equal(lift({ userTier: 3, lockerTier: 2 }), true);
});

test('lift: deleted locker resolves to tier 0 → any manager may lift', () => {
  assert.equal(lift({ lockedBy: 'ghost', lockerTier: 0, userTier: 1 }), true);
});

// ── #152: debris snap ────────────────────────────────────────────────────────
test('snapDebrisLevel: rounds to nearest 10 and clamps', () => {
  assert.equal(snapDebrisLevel(0), 0);
  assert.equal(snapDebrisLevel(14.9), 10);
  assert.equal(snapDebrisLevel(15), 20);
  assert.equal(snapDebrisLevel(73), 70);
  assert.equal(snapDebrisLevel(104), 100);
  assert.equal(snapDebrisLevel(-3), 0);
  assert.equal(snapDebrisLevel(NaN), 0);
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd apps/mobile
node --import tsx --import ./src/test/setupGlobals.mjs --test src/components/vehicles/vehicleSessionLogic.test.ts
```

Expected: FAIL — `resolveVehicleAvailability` (etc.) not exported.

- [ ] **Step 3: Implement** — append to `vehicleSessionLogic.ts`:

```ts
// ── #155: checkout availability (role-free, owner-aware) ───────────────────

export type AvailabilityReason = 'checked_out' | 'owned_closed';
export interface VehicleAvailability { available: boolean; reason: AvailabilityReason | null; }

/**
 * #155: available ⇔ no open session AND (unowned OR opted in OR caller owns it).
 * Role NEVER gates vehicle checkout. Locking (#167) composes on top via
 * isCheckoutLockedFor — it is deliberately not this function's concern.
 */
export function resolveVehicleAvailability(input: {
  ownerUserId: string | null;
  openCheckout: number; // vehicles.open_checkout 0/1
  hasOpenSession: boolean;
  userId: string | null;
}): VehicleAvailability {
  if (input.hasOpenSession) return { available: false, reason: 'checked_out' };
  if (input.ownerUserId == null) return { available: true, reason: null };
  if (input.userId != null && input.userId === input.ownerUserId) return { available: true, reason: null };
  if (input.openCheckout) return { available: true, reason: null };
  return { available: false, reason: 'owned_closed' };
}

/**
 * #167 lock hierarchy: may the caller LIFT (and therefore bypass) the current
 * lock? canManage is the caller's canManageVehicle result; tiers are ROLE_TIER
 * values resolved by the caller (this module stays DB-free). Legacy NULL locker
 * and self-locks are always liftable by a manager; otherwise tier must be >=
 * the locker's CURRENT tier (deleted locker → pass 0).
 */
export function canLiftVehicleLock(input: {
  canManage: boolean;
  lockedBy: string | null;
  lockerTier: number;
  userId: string | null;
  userTier: number;
}): boolean {
  if (!input.canManage) return false;
  if (input.lockedBy == null) return true;
  if (input.userId != null && input.lockedBy === input.userId) return true;
  return input.userTier >= input.lockerTier;
}

/** #152: committed debris values snap to 10s and clamp to 0–100 (drag is continuous, commit is coarse). */
export function snapDebrisLevel(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.min(100, Math.max(0, Math.round(raw / 10) * 10));
}
```

- [ ] **Step 4: Run tests to verify they pass** (same command). Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/vehicles/vehicleSessionLogic.ts src/components/vehicles/vehicleSessionLogic.test.ts
git commit -m "feat(#152,#155,#167): pure logic — availability, lock-lift rule, debris snap

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `isCheckoutLockedFor` — bypass follows unlock

**Files:**
- Modify: `apps/mobile/src/db/queries/vehicles.ts` (`isCheckoutLockedFor` ~line 354, `assertCheckoutAllowed` ~line 376)

**Interfaces:**
- Consumes: `canLiftVehicleLock` from Task 1 (add to the existing `vehicleSessionLogic` import in this file, which already imports `buildClosePayload`/`resolveLockStamp`/etc.).
- Produces: `isCheckoutLockedFor(locationId, userId)` — same signature, stricter semantics (a higher-tier lock now blocks even the owner). Task 6 and Task 8 rely on this.

- [ ] **Step 1: Replace the function body** (⚠️ this SQL duplicates `canManageVehicle` logic — the paired site is `queries/access.ts`; both comments must keep pointing at each other):

```ts
/**
 * Lock guard for every session-opening path (checkOutVehicle / takeOverVehicle).
 * #157 introduced the lock; #167 made BYPASS FOLLOW UNLOCK: when locked, only a
 * caller who could lift the lock passes — canManageVehicle AND (legacy NULL
 * locker OR self-lock OR own tier >= locker's CURRENT tier). A crew owner whose
 * vehicle was locked by a PM is blocked from checkout too. The manage predicate
 * below duplicates canManageVehicle (queries/access.ts) — kept in sync manually:
 * this path resolves from a bare userId, not a UserSession.
 */
export function isCheckoutLockedFor(locationId: string, userId: string | null): boolean {
  const db = getDb();
  const row = rowsAs<{
    checkout_locked: number; locked_by: string | null; owner_user_id: string | null;
    role: string | null; locker_role: string | null;
  }>(
    db.executeSync(
      `SELECT v.checkout_locked, v.locked_by, l.owner_user_id,
              (SELECT role FROM users WHERE id = ?) AS role,
              (SELECT role FROM users WHERE id = v.locked_by) AS locker_role
         FROM vehicles v JOIN locations l ON l.id = v.location_id
        WHERE v.location_id = ?`,
      [userId, locationId],
    ).rows,
  )[0];
  if (!row || !row.checkout_locked) return false;
  const tier = ROLE_TIER[row.role as UserRole] ?? 0;
  const manages =
    (userId != null && row.owner_user_id === userId)
    || tier >= 3
    || (tier >= 2 && userId != null && sharesTeamWithOwner(userId, row.owner_user_id));
  if (!manages) return true;
  return !canLiftVehicleLock({
    canManage: true,
    lockedBy: row.locked_by,
    lockerTier: ROLE_TIER[row.locker_role as UserRole] ?? 0,
    userId,
    userTier: tier,
  });
}
```

- [ ] **Step 2: Update the throw message** in `assertCheckoutAllowed` — the locker is no longer necessarily the owner:

```ts
    throw new Error('This vehicle is locked from checkout.');
```

- [ ] **Step 3: Typecheck + full suite**

```bash
pnpm exec tsc --noEmit && pnpm test
```

Expected: tsc clean; 574+13 tests pass (Task 1 added 13).

- [ ] **Step 4: Commit**

```bash
git add src/db/queries/vehicles.ts
git commit -m "feat(#167): isCheckoutLockedFor — bypass follows the unlock rule

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `canLiftVehicleLockFor` DB wrapper in access.ts

**Files:**
- Modify: `apps/mobile/src/db/queries/access.ts` (append after `canManageVehicle`, ~line 350)

**Interfaces:**
- Consumes: `canManageVehicle` (same file), `canLiftVehicleLock` (Task 1), `getDb`/`rowsAs`/`ROLE_TIER`/`UserRole` (already imported in this file).
- Produces: `canLiftVehicleLockFor(user: UserSession | null | undefined, location: Pick<Location, 'owner_user_id'> | null | undefined, vehicle: { checkout_locked: number; locked_by: string | null } | null | undefined): boolean` — Tasks 5 and 6 import this. Returns `true` when the vehicle is unlocked (nothing to lift ⇒ toggling ON is governed by `canManageVehicle` alone).

- [ ] **Step 1: Implement**

```ts
import { canLiftVehicleLock } from '../../components/vehicles/vehicleSessionLogic';
```

(Placement: alongside the file's existing imports. `queries/vehicles.ts` already imports from this module — same direction, no cycle: `vehicleSessionLogic` imports nothing from `db/`.)

```ts
/**
 * #167: may `user` lift the vehicle's current lock (and therefore flip the
 * toggle OFF / bypass it)? Unlocked → true (locking ON is gated by
 * canManageVehicle alone). Locker tier resolves from their CURRENT role;
 * a deleted locker resolves to tier 0.
 */
export function canLiftVehicleLockFor(
  user: UserSession | null | undefined,
  location: Pick<Location, 'owner_user_id'> | null | undefined,
  vehicle: { checkout_locked: number; locked_by: string | null } | null | undefined,
): boolean {
  if (!user || !location) return false;
  if (!vehicle?.checkout_locked) return true;
  let lockerRole: string | null = null;
  if (vehicle.locked_by) {
    lockerRole = rowsAs<{ role: string | null }>(getDb().executeSync(
      `SELECT role FROM users WHERE id = ?`, [vehicle.locked_by],
    ).rows)[0]?.role ?? null;
  }
  return canLiftVehicleLock({
    canManage: canManageVehicle(user, location),
    lockedBy: vehicle.locked_by,
    lockerTier: ROLE_TIER[lockerRole as UserRole] ?? 0,
    userId: user.id,
    userTier: ROLE_TIER[user.role] ?? 0,
  });
}
```

- [ ] **Step 2: Typecheck + suite** — `pnpm exec tsc --noEmit && pnpm test`. Expected: clean/green (tier matrix is covered by Task 1's pure tests; this wrapper is thin plumbing).

- [ ] **Step 3: Commit**

```bash
git add src/db/queries/access.ts
git commit -m "feat(#167): canLiftVehicleLockFor — DB-resolved locker tier wrapper

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `VerticalLevelSlider` kit component

**Files:**
- Create: `apps/mobile/src/components/ui/VerticalLevelSlider.tsx`

**Interfaces:**
- Consumes: nothing project-specific beyond the theme hooks.
- Produces: `<VerticalLevelSlider value={number} onCommit={(rawPct: number) => void} disabled?: boolean />` — commits the RAW 0–100 position on release; **snapping is the caller's job** (Task 6 wraps it in `snapDebrisLevel`). Generic on purpose — no vehicles imports here.

- [ ] **Step 1: Create the component** (PanResponder precedent: `ui/DragList.tsx` — refs mirror per-render values so the once-created responder never goes stale; `locationY` on grant + `dy` accumulation avoids `measureInWindow`, so it works identically on web):

```tsx
import { useMemo, useRef, useState } from 'react';
import { View, Text, PanResponder, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

interface Props {
  /** Committed value 0–100 (shown when not dragging). */
  value: number;
  /** Fired on release with the raw (unsnapped) 0–100 position. */
  onCommit: (rawPct: number) => void;
  disabled?: boolean;
}

/**
 * Vertical drag-to-fill level control (#152 debris). Pure PanResponder — no
 * native module, web-safe (precedent: DragList). The fill tracks the finger
 * continuously; the caller decides how to quantize the committed value.
 */
export function VerticalLevelSlider({ value, onCommit, disabled }: Props) {
  const s = useThemedStyles(makeStyles);
  const [drag, setDrag] = useState<number | null>(null);
  // Refs, not state, inside the responder: setState is async and the once-
  // created responder must always read current values (DragList pattern).
  const cfg = useRef({ disabled: !!disabled, onCommit });
  cfg.current = { disabled: !!disabled, onCommit };
  const dragRef = useRef<number | null>(null);
  const heightRef = useRef(1);
  const grantPct = useRef(0);

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => !cfg.current.disabled,
    onMoveShouldSetPanResponder: () => !cfg.current.disabled,
    onPanResponderGrant: evt => {
      const pct = clampPct(100 * (1 - evt.nativeEvent.locationY / heightRef.current));
      grantPct.current = pct;
      dragRef.current = pct;
      setDrag(pct);
    },
    onPanResponderMove: (_e, g) => {
      const pct = clampPct(grantPct.current - (g.dy / heightRef.current) * 100);
      dragRef.current = pct;
      setDrag(pct);
    },
    onPanResponderRelease: () => {
      const v = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (v != null) cfg.current.onCommit(v);
    },
    onPanResponderTerminate: () => { dragRef.current = null; setDrag(null); },
  }), []);

  const display = drag ?? clampPct(value);
  return (
    <View style={s.row}>
      <View
        style={[s.track, disabled && s.trackDisabled]}
        onLayout={e => { heightRef.current = Math.max(1, e.nativeEvent.layout.height); }}
        {...responder.panHandlers}
      >
        <View style={[s.fill, { height: `${display}%` }]} />
      </View>
      <Text style={s.pct}>{Math.round(display)}%</Text>
    </View>
  );
}

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, n));
}

const makeStyles = (t: Theme) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: t.spacing.md },
  track: {
    width: 44,
    height: 140,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.background,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  trackDisabled: { opacity: 0.5 },
  fill: { width: '100%', backgroundColor: t.colors.primaryBg },
  pct: { fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.textSecondary, marginBottom: t.spacing.xs },
});
```

- [ ] **Step 2: Typecheck** — `pnpm exec tsc --noEmit`. Expected: clean. (Behavioral verification is on-device in Task 9 — there is no component test harness in this repo.)

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/VerticalLevelSlider.tsx
git commit -m "feat(#152): VerticalLevelSlider — PanResponder drag-to-fill kit control

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: VehicleEditSheet — debris option, open_checkout, tiered lock row, owner access

**Files:**
- Modify: `apps/mobile/src/components/vehicles/VehicleEditSheet.tsx` (whole component — 154 lines today)

**Interfaces:**
- Consumes: `canLiftVehicleLockFor` (Task 3), `canManageVehicle`, `getUserById`, `usePermission`, existing `upsertVehicleState`.
- Produces: same external API (`{ locationId, visible, onClose }`); behavior only.

Behavior summary (spec §1/§2/§3):
- **isEditor** = `usePermission('edit_inventory')`. Non-editors (owner or manager who reached the sheet via Task 6's widened link) see ONLY the rows they may write: lock + open_checkout. Name/model/truck-mount/debris are hidden for them, and `handleSave` skips the rename path entirely.
- New **debris pill** under truck mount (editors only): `Debris tracker` / `No debris tracker`, tone `primary`/`neutral`.
- New **open_checkout pill** (only when the location HAS an owner, gated `canManageVehicle`): `Anyone can check out` / `Owner-only`, tone `primary`/`neutral`.
- **Lock row**: locking ON needs `canManageVehicle` (unchanged); flipping OFF an existing lock additionally needs `canLiftVehicleLockFor`. When not liftable, render a read-only row — the pill `🔒 Locked by <name>` (no "tap to toggle" hint) — and exclude `checkout_locked` from the save patch.

- [ ] **Step 1: Rewrite the component**

```tsx
import { useEffect, useState } from 'react';
import { Alert, Pressable, Text, StyleSheet } from 'react-native';
import { EntityEditSheet } from '../ui/EntityEditSheet';
import { TextField } from '../ui/TextField';
import { StatusPill } from '../ui/StatusPill';
import { TaxonomyChips } from '../pickers';
import { getLocationById, upsertLocation } from '../../db/queries/locations';
import { getVehicle, upsertVehicleState, VEHICLE_MODEL_CATEGORY, type VehicleStatePatch } from '../../db/queries/vehicles';
import { getUserById } from '../../db/queries/users';
import { runInTransaction } from '../../db/tx';
import { appendOutbox } from '../../sync/outbox';
import { isWriteBlocked } from '../../db/maintenance';
import { useSession } from '../../hooks/useSession';
import { usePermission } from '../../hooks/usePermission';
import { validateName } from '../../lib/validation';
import { canManageVehicle, canLiftVehicleLockFor } from '../../db/queries/access';
import { track } from '../../telemetry';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

interface Props {
  locationId: string;
  visible: boolean;
  onClose: () => void;
}

/**
 * Edit a vehicle's identity/spec: name, model, truck mount, debris option
 * (#152). Equipment spec lives here (not the panel) — see #122 follow-up.
 * #155 widened access: the OWNER can open this sheet without edit_inventory,
 * but sees only the shared-access rows (lock + open_checkout); identity/spec
 * stays editor-only. #167: an existing lock set by a higher tier renders
 * read-only here — canLiftVehicleLockFor gates flipping it off.
 */
export function VehicleEditSheet({ locationId, visible, onClose }: Props) {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();
  const isEditor = usePermission('edit_inventory');

  const [name, setName] = useState('');
  const [model, setModel] = useState<{ id: string | null; label: string | null }>({ id: null, label: null });
  const [truckMount, setTruckMount] = useState(false);
  const [debrisOption, setDebrisOption] = useState(false);
  const [checkoutLocked, setCheckoutLocked] = useState(false);
  const [openCheckout, setOpenCheckout] = useState(false);
  const [hasOwner, setHasOwner] = useState(false);
  // #165: owner / tier-3+ / same-team tier-2 manager (canManageVehicle).
  const [canLock, setCanLock] = useState(false);
  // #167: may flip an EXISTING lock off (tier >= locker's tier, or self/legacy).
  const [canLift, setCanLift] = useState(true);
  const [lockerName, setLockerName] = useState<string | null>(null);
  const [nameError, setNameError] = useState('');

  // Re-seed each open: edits the CURRENT row; a sync pull while closed must not
  // leave stale initial values. While open, fields are user-owned.
  useEffect(() => {
    if (!visible) return;
    const location = getLocationById(locationId);
    const vehicle = getVehicle(locationId);
    setName(location?.name ?? '');
    setModel({ id: vehicle?.model_id ?? null, label: vehicle?.model ?? null });
    setTruckMount(!!vehicle?.truck_mount);
    setDebrisOption(!!vehicle?.debris_option);
    setCheckoutLocked(!!vehicle?.checkout_locked);
    setOpenCheckout(!!vehicle?.open_checkout);
    setHasOwner(location?.owner_user_id != null);
    setCanLock(canManageVehicle(user, location ?? null));
    setCanLift(canLiftVehicleLockFor(user, location ?? null, vehicle));
    setLockerName(vehicle?.locked_by ? getUserById(vehicle.locked_by)?.name ?? null : null);
    setNameError('');
  }, [visible, locationId, user]);

  // EntityEditSheet contract: throw to keep the sheet open; return to close.
  function handleSave() {
    if (isWriteBlocked()) throw new Error('write blocked');
    const location = getLocationById(locationId);
    if (!location) throw new Error('vehicle location missing');

    let newName = location.name;
    if (isEditor) {
      const nameResult = validateName(name);
      if (!nameResult.ok) {
        track('audit', 'validation_reject', { screen: 'vehicle_edit', props: { field: 'vehicle.name', rule: nameResult.rule } });
        setNameError(nameResult.error);
        throw new Error(`validation: ${nameResult.rule}`);
      }
      newName = nameResult.value;
    }
    setNameError('');
    const now = new Date().toISOString();

    // Each holder patches only the fields their gate covers; everything else
    // stays untouched so concurrent writers don't clobber each other.
    const patch: VehicleStatePatch = {
      ...(isEditor ? {
        model: model.label, model_id: model.id,
        truck_mount: truckMount ? 1 : 0,
        debris_option: debrisOption ? 1 : 0,
      } : {}),
      // #167: only include the lock when the caller may write the transition —
      // locking ON needs canLock; flipping an existing lock OFF also needs canLift.
      ...(canLock && (canLift || checkoutLocked) ? { checkout_locked: checkoutLocked ? 1 : 0 } : {}),
      ...(canLock && hasOwner ? { open_checkout: openCheckout ? 1 : 0 } : {}),
    };

    try {
      runInTransaction(() => {
        if (isEditor && newName !== location.name) {
          const updated = { ...location, name: newName, updated_at: now, synced_at: null };
          upsertLocation(updated);
          // synced_at is local-only — strip from the outbox payload (server has
          // no such column); active as boolean mirrors VehicleQuickAdd.
          const {
            synced_at: _s,
            type_id: _typeId,
            active,
            subareas_require_owner,
            has_shelves,
            ...locRow
          } = updated;
          appendOutbox('INSERT', 'locations', {
            ...locRow,
            active: active === 1,
            subareas_require_owner: !!subareas_require_owner,
            has_shelves: !!has_shelves,
          });
        }
        if (Object.keys(patch).length > 0) {
          upsertVehicleState(locationId, patch, user?.id ?? null);
        }
      });
    } catch (err) {
      Alert.alert('Save failed', err instanceof Error ? err.message : 'Unknown error');
      throw err;
    }
  }

  return (
    <EntityEditSheet visible={visible} onClose={onClose} title="Edit Vehicle" onSave={handleSave}>
      {isEditor && (
        <>
          <TextField
            label="Name"
            required
            value={name}
            onChangeText={v => { setName(v); if (nameError) setNameError(''); }}
            error={nameError || null}
          />
          <TaxonomyChips
            category={VEHICLE_MODEL_CATEGORY}
            label="Model"
            deselectable
            valueId={model.id}
            valueLabel={model.label}
            onChange={setModel}
          />
          <Pressable onPress={() => setTruckMount(v => !v)} style={s.truckRow}>
            <StatusPill
              label={truckMount ? 'Truck mount' : 'No truck mount'}
              tone={truckMount ? 'primary' : 'neutral'}
            />
            <Text style={s.toggleHint}>tap to toggle</Text>
          </Pressable>
          {/* #152: debris tracker is equipment spec like the truck mount. */}
          <Pressable onPress={() => setDebrisOption(v => !v)} style={s.truckRow}>
            <StatusPill
              label={debrisOption ? 'Debris tracker' : 'No debris tracker'}
              tone={debrisOption ? 'primary' : 'neutral'}
            />
            <Text style={s.toggleHint}>tap to toggle</Text>
          </Pressable>
        </>
      )}
      {/* #157/#167: lock row. Not liftable → read-only display, no hint. */}
      {canLock && (canLift || !checkoutLocked ? (
        <Pressable onPress={() => setCheckoutLocked(v => !v)} style={s.truckRow}>
          <StatusPill
            label={checkoutLocked ? '🔒 Locked from checkout' : 'Checkout open'}
            tone={checkoutLocked ? 'warning' : 'neutral'}
          />
          <Text style={s.toggleHint}>tap to toggle</Text>
        </Pressable>
      ) : (
        <Pressable style={s.truckRow} disabled>
          <StatusPill label={`🔒 Locked by ${lockerName ?? 'a manager'}`} tone="warning" />
        </Pressable>
      ))}
      {/* #155: owner opt-in — meaningful only on owned vehicles. Wording is
          deliberately distinct from the lock's "Checkout open". */}
      {canLock && hasOwner && (
        <Pressable onPress={() => setOpenCheckout(v => !v)} style={s.truckRow}>
          <StatusPill
            label={openCheckout ? 'Anyone can check out' : 'Owner-only'}
            tone={openCheckout ? 'primary' : 'neutral'}
          />
          <Text style={s.toggleHint}>tap to toggle</Text>
        </Pressable>
      )}
    </EntityEditSheet>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  truckRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, marginBottom: t.spacing.base },
  toggleHint: { fontSize: t.typography.fontSizes.xs, color: t.colors.textMuted },
});
```

- [ ] **Step 2: Typecheck + suite** — `pnpm exec tsc --noEmit && pnpm test`. Expected: clean/green.
  (If `VehicleStatePatch` is not exported from `queries/vehicles.ts`, add `export` to its declaration — it is already exported today, ~line 105.)

- [ ] **Step 3: Commit**

```bash
git add src/components/vehicles/VehicleEditSheet.tsx
git commit -m "feat(#152,#155,#167): edit sheet — debris option, owner opt-in, tiered lock row, owner access

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: VehiclePanel — availability button, debris slider, locked-by pills, owner Edit link

**Files:**
- Modify: `apps/mobile/src/components/vehicles/VehiclePanel.tsx`

**Interfaces:**
- Consumes: `resolveVehicleAvailability` + `snapDebrisLevel` (Task 1, from `./vehicleSessionLogic`), `canLiftVehicleLockFor` (Task 3), `VerticalLevelSlider` (Task 4).
- Produces: no API change (`{ locationId, variant, onNavigate }`).

- [ ] **Step 1: Imports** — extend the existing import lines:

```tsx
import {
  resolveCheckoutAction, formatSince, waterTankLabel, wasteTankLabel,
  resolveVehicleAvailability, snapDebrisLevel,
} from './vehicleSessionLogic';
import { canManageVehicle, canLiftVehicleLockFor } from '../../db/queries/access';
import { VerticalLevelSlider } from '../ui/VerticalLevelSlider';
```

- [ ] **Step 2: Remove the role gate, add the new derivations.** Delete the `const canCheckout = usePermission('checkout_inventory');` line (line 68 — #155 rule 1: role never gates vehicle checkout; `usePermission` stays imported for `canEdit`/`canManageLocations`). Then replace the block after `const action = resolveCheckoutAction(...)` (lines 109–117) with:

```tsx
  const action = resolveCheckoutAction(active, user?.id ?? null);
  const nowIso = new Date().toISOString();
  const holderName = active?.user_name ?? active?.user_id ?? '';
  const isOut = action.kind !== 'check_out';
  const isMine = action.kind === 'check_in';
  // #165: shared predicate — owner / tier-3+ / same-team tier-2 manager.
  const canManage = canManageVehicle(user, location);
  // #167: bypass follows unlock — only a caller who could lift the lock passes.
  const canBypassLock = canLiftVehicleLockFor(user, location, vehicle);
  const lockerName = vehicle?.locked_by ? (getUserById(vehicle.locked_by)?.name ?? null) : null;
  const checkoutBlocked = !!vehicle?.checkout_locked && !canBypassLock && action.kind !== 'check_in';
  // #155: owner-aware availability (session state handled by `action` above,
  // so hasOpenSession is false here — this decides the owned/opt-in half only).
  const availability = resolveVehicleAvailability({
    ownerUserId: location.owner_user_id,
    openCheckout: vehicle?.open_checkout ?? 0,
    hasOpenSession: false,
    userId: user?.id ?? null,
  });
  const ownedBlocked = !availability.available && action.kind !== 'check_in';
```

- [ ] **Step 3: Guard the press handler** — in `onPrimaryPress`, replace the `if (checkoutBlocked) return;` line with:

```tsx
    if (checkoutBlocked || ownedBlocked) return; // #157/#167 lock, #155 owner-closed
```

- [ ] **Step 4: Edit link opens for the owner** (#155) — replace the header's gate (line 187):

```tsx
        {variant === 'full' && (canEdit || location.owner_user_id === user?.id) && !locked && (
```

- [ ] **Step 5: Status pills** — in `statusPills`, replace the lock pill line (222) and add the debris pill directly after it:

```tsx
      {/* #157/#167: visible-but-locked — everyone sees the lock and who set it;
          only someone who can lift it (tier rule) can still check out. */}
      {!!vehicle?.checkout_locked && (
        <StatusPill label={`🔒 Locked${lockerName ? ` by ${lockerName}` : ''}`} tone="neutral" />
      )}
      {/* #152: debris level rides the pill row whenever the tracker is on. */}
      {!!vehicle?.debris_option && (
        <StatusPill
          label={`Debris ${vehicle?.debris_level ?? 0}%`}
          tone={(vehicle?.debris_level ?? 0) >= 80 ? 'warning' : 'neutral'}
        />
      )}
```

- [ ] **Step 6: State-card lock pill honors the lift rule** — replace the `{canManage && !locked && (...)}` Pressable block (lines 278–296) with:

```tsx
        {/* #165/#167: lock toggle — locking ON needs canManage; flipping an
            existing lock OFF also needs the lift rule (tier >= locker's tier).
            Not liftable → read-only pill, no toggle hint. */}
        {canManage && !locked && (
          (vehicle?.checkout_locked ? canBypassLock : true) ? (
            <Pressable
              onPress={() => {
                if (isWriteBlocked()) return;
                upsertVehicleState(
                  locationId,
                  { checkout_locked: vehicle?.checkout_locked ? 0 : 1 },
                  user?.id ?? null,
                );
              }}
              style={s.truckRow}
            >
              <StatusPill
                label={vehicle?.checkout_locked ? '🔒 Locked from checkout' : 'Checkout open'}
                tone={vehicle?.checkout_locked ? 'warning' : 'neutral'}
              />
              <Text style={s.toggleHint}>tap to toggle</Text>
            </Pressable>
          ) : (
            <View style={s.truckRow}>
              <StatusPill label={`🔒 Locked by ${lockerName ?? 'a manager'}`} tone="warning" />
            </View>
          )
        )}
```

- [ ] **Step 7: Debris slider row** — inside the State card, after the truck-mount-gated tank block (after line 324's `)}`), add:

```tsx
        {/* #152: debris level — independent of the truck mount; drag commits
            snapped to 10s. Ungated like the tanks (crew-level state). */}
        {!!vehicle?.debris_option && (
          <>
            <FieldLabel style={s.waterLabel}>Debris level</FieldLabel>
            {locked ? (
              <Text style={s.muted}>{`${vehicle?.debris_level ?? 0}%`}</Text>
            ) : (
              <VerticalLevelSlider
                value={vehicle?.debris_level ?? 0}
                onCommit={raw => {
                  if (isWriteBlocked()) return;
                  upsertVehicleState(locationId, { debris_level: snapDebrisLevel(raw) }, user?.id ?? null);
                }}
              />
            )}
          </>
        )}
```

- [ ] **Step 8: Checkout button — availability states** — replace the `{canCheckout && (...)}` PrimaryButton block (lines 351–361) with (no permission wrapper anymore):

```tsx
        <PrimaryButton
          label={
            action.kind === 'check_in' ? 'Check In'
            : ownedBlocked ? `Owned by ${owner?.name ?? 'someone'}`
            : checkoutBlocked ? `🔒 Locked by ${lockerName ?? 'owner'}`
            : action.kind === 'take_over' ? 'Take Over' : 'Check Out'
          }
          onPress={() => { void onPrimaryPress(); }}
          tone={action.kind === 'take_over' && !checkoutBlocked && !ownedBlocked ? 'danger' : 'primary'}
          disabled={locked || checkoutBlocked || ownedBlocked}
          style={s.primaryBtn}
        />
```

- [ ] **Step 9: Typecheck + suite** — `pnpm exec tsc --noEmit && pnpm test`. Expected: clean/green (also confirms `usePermission`'s `canCheckout` removal left no dangling reference).

- [ ] **Step 10: Commit**

```bash
git add src/components/vehicles/VehiclePanel.tsx
git commit -m "feat(#152,#155,#167): panel — availability button, debris slider, locked-by pills, owner edit link

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: VehicleQuickAdd + ensureVehicleRow — debris at creation

**Files:**
- Modify: `apps/mobile/src/db/queries/vehicles.ts` (`ensureVehicleRow`, ~line 174)
- Modify: `apps/mobile/src/components/quickadd/VehicleQuickAdd.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ensureVehicleRow(locationId, init?: { model?; model_id?; truck_mount?: 0 | 1; debris_option?: 0 | 1 })` — other creation callers (`findOrCreateVehicleByName`, generic location form) are untouched; the new field is optional and defaults to 0.

- [ ] **Step 1: Extend `ensureVehicleRow`** — add `debris_option` to the init type, the INSERT, and the outbox payload:

```ts
export function ensureVehicleRow(
  locationId: string,
  init?: { model?: string | null; model_id?: string | null; truck_mount?: 0 | 1; debris_option?: 0 | 1 },
): void {
  runInTransaction(() => {
    if (getVehicle(locationId)) return;
    const now = new Date().toISOString();
    const truckMount = init?.truck_mount ?? 0;
    const debrisOption = init?.debris_option ?? 0;
    const db = getDb();
    db.executeSync(
      `INSERT OR IGNORE INTO vehicles (location_id, truck_mount, water_state, model, model_id, notes, updated_at, synced_at, water_tank, waste_tank, checkout_locked, debris_option)
       VALUES (?, ?, NULL, ?, ?, NULL, ?, NULL, 'empty', 'clean', 0, ?)`,
      bindParams([locationId, truckMount, init?.model ?? null, init?.model_id ?? null, now, debrisOption]),
    );
    appendOutbox('INSERT', 'vehicles', {
      location_id: locationId, truck_mount: truckMount,
      model: init?.model ?? null, model_id: init?.model_id ?? null,
      notes: null, updated_at: now, water_tank: 'empty', waste_tank: 'clean',
      checkout_locked: 0, debris_option: debrisOption,
    });
  });
}
```

- [ ] **Step 2: QuickAdd pill** — in `VehicleQuickAdd.tsx`: add state next to `truckMount` (~line 56), the pill after the truck-mount Pressable (~line 158), and pass it through (~line 100):

```tsx
  const [debrisOption, setDebrisOption] = useState(false);
```

```tsx
      <Pressable onPress={() => setDebrisOption(v => !v)} style={s.truckRow}>
        <StatusPill
          label={debrisOption ? 'Debris tracker' : 'No debris tracker'}
          tone={debrisOption ? 'primary' : 'neutral'}
        />
        <Text style={s.toggleHint}>tap to toggle</Text>
      </Pressable>
```

```tsx
      ensureVehicleRow(id, { model: model.label, model_id: model.id, truck_mount: truckMount ? 1 : 0, debris_option: debrisOption ? 1 : 0 });
```

Also reset it beside the existing post-save `setName('')`: add `setDebrisOption(false);` (truck mount: match whatever the existing reset does with `setTruckMount` — mirror it).

- [ ] **Step 3: Typecheck + suite** — `pnpm exec tsc --noEmit && pnpm test`. Expected: clean/green.

- [ ] **Step 4: Commit**

```bash
git add src/db/queries/vehicles.ts src/components/quickadd/VehicleQuickAdd.tsx
git commit -m "feat(#152): debris option at vehicle creation (QuickAdd + ensureVehicleRow)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Vehicles list — Available segment

**Files:**
- Modify: `apps/mobile/src/db/queries/vehicles.ts` (append near `isCheckoutLockedFor`)
- Modify: `apps/mobile/app/(app)/(vehicles)/index.tsx`

**Interfaces:**
- Consumes: `resolveVehicleAvailability` (Task 1), `isCheckoutLockedFor` (Task 2).
- Produces: `isVehicleAvailableForCheckout(locationId: string, userId: string | null): boolean`.

- [ ] **Step 1: The query helper** (per-row query is the list's existing pattern — `VehicleInlineStatus` does the same; vehicle lists are small):

```ts
/**
 * #155: is this vehicle in the caller's checkable set RIGHT NOW? Free of an
 * open session AND (unowned OR opted in OR theirs) AND not locked against them
 * (#167 tier rule via isCheckoutLockedFor). Backs the list's Available segment;
 * the panel button derives the same answer from its own loaded rows.
 */
export function isVehicleAvailableForCheckout(locationId: string, userId: string | null): boolean {
  const db = getDb();
  const row = rowsAs<{ owner_user_id: string | null; open_checkout: number | null; has_open: number }>(
    db.executeSync(
      `SELECT l.owner_user_id, v.open_checkout,
              EXISTS(SELECT 1 FROM vehicle_checkouts c
                      WHERE c.vehicle_location_id = l.id AND c.checked_in_at IS NULL) AS has_open
         FROM locations l LEFT JOIN vehicles v ON v.location_id = l.id
        WHERE l.id = ?`,
      [locationId],
    ).rows,
  )[0];
  if (!row) return false;
  const a = resolveVehicleAvailability({
    ownerUserId: row.owner_user_id,
    openCheckout: row.open_checkout ?? 0,
    hasOpenSession: !!row.has_open,
    userId,
  });
  return a.available && !isCheckoutLockedFor(locationId, userId);
}
```

(Add `resolveVehicleAvailability` to this file's existing `vehicleSessionLogic` import.)

- [ ] **Step 2: The screen** — in `app/(app)/(vehicles)/index.tsx`:

Import the helper and `useTableVersion`:

```tsx
import { isVehicleAvailableForCheckout } from '../../../src/db/queries/vehicles';
import { useTableVersion } from '../../../src/hooks/useDataVersion';
```

Widen the segment state and derivation (replaces lines 33–36):

```tsx
  // null = user hasn't touched the control; managers (showsAll) default to All.
  const [segmentChoice, setSegmentChoice] = useState<'team' | 'all' | 'available' | null>(null);
  // Empty team set falls back to All (and the control reflects it).
  const segment = segmentChoice === 'team' && teamUnits.length === 0
    ? 'all'
    : segmentChoice ?? (teamUnits.length === 0 || showsAll ? 'all' : 'team');
  // #155: the checkable set — availability + the #167 lock, per caller.
  const tableKey = useTableVersion(['vehicles', 'vehicle_checkouts']);
  const availableUnits = useMemo(
    () => (segment === 'available'
      ? allUnits.filter(l => isVehicleAvailableForCheckout(l.id, user?.id ?? null))
      : []),
    [segment, allUnits, user?.id, refreshKey, tableKey],
  );
  const units = segment === 'team' ? teamUnits : segment === 'available' ? availableUnits : allUnits;
```

Segments (replaces the `segments={[...]}` array) and `onChange`:

```tsx
          <SegmentedControl
            segments={[
              { id: 'team', label: 'Team Vehicles' },
              { id: 'all', label: 'All Vehicles' },
              { id: 'available', label: 'Available' },
            ]}
            value={segment}
            onChange={id => setSegmentChoice(id as 'team' | 'all' | 'available')}
          />
```

Empty state — replace the single `units.length === 0` EmptyState with a segment-aware one:

```tsx
        {units.length === 0 ? (
          segment === 'available' ? (
            <EmptyState icon="🚐" title="No vehicles available"
              subtitle="Nothing is free to check out right now — owned vehicles appear here when their owner opts in." />
          ) : (
            <EmptyState icon="🚐" title="No vehicles yet"
              subtitle="Vehicles you own, share a team with, or were granted access to show up here." />
          )
        ) : (
```

- [ ] **Step 3: Typecheck + suite** — `pnpm exec tsc --noEmit && pnpm test`. Expected: clean/green.

- [ ] **Step 4: Commit**

```bash
git add src/db/queries/vehicles.ts "app/(app)/(vehicles)/index.tsx"
git commit -m "feat(#155): vehicles list — Available segment (checkable set per caller)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Full verification + hotload device pass

**Files:** none (verification)

- [ ] **Step 1: Both suites + typecheck**

```bash
cd /home/tdpotato/projects/InventoryPro/apps/mobile && pnpm exec tsc --noEmit && pnpm test
cd /home/tdpotato/projects/InventoryPro/apps/api && pnpm exec tsc --noEmit && pnpm test
```

Expected: mobile ≥587 pass (574 baseline + 13 new), API 417/417, both tsc clean. API is untouched this wave — its suite is a regression canary only.

- [ ] **Step 2: Hotload** (CLAUDE.md directive) — invoke the repo `start-metro` skill (it handles the port-8081 squatters, health check, and `adb reverse`). Metro must serve THIS branch's checkout — verify "Starting project at" in metro.log points at the main worktree, now on `vehicles-ui-wave1`.

- [ ] **Step 3: Device verification with the user** (⚠️ do not edit code while they test):
  - #152: debris pill in Edit sheet + QuickAdd; slider appears only when the option is on; drag feels right; committed value lands on a 10; pill shows `Debris N%`; tanks still hidden without truck mount.
  - #155: crew role (no `checkout_inventory`) sees and uses Check Out on an unowned vehicle; owned non-opted vehicle shows disabled `Owned by <name>`; opt-in flips it; Available segment lists exactly the checkable set; owner without `edit_inventory` can open Edit and sees only the two shared-access pills.
  - #167: PM locks a crew-owned vehicle → crew owner sees `🔒 Locked by <PM name>` and CANNOT check out or unlock; the PM (equal tier) and admin can; self-lock and legacy locks still liftable by any manager.
  - Web sanity check (Expo Web): slider drags with a mouse; no native-module crash.

- [ ] **Step 4: Fix-forward anything found, re-run Step 1, commit fixes** with `fix(#NNN): ...` messages.

---

### Task 10: Merge + board

**Files:** none (git/board)

- [ ] **Step 1: Merge via superpowers:finishing-a-development-branch** (present the merge/PR options; on this repo the pattern has been fast-forward merge to local `main`, then push).

- [ ] **Step 2: Board updates via the `board` skill** — after device verification: move #152, #155, #167 to Done (they were In progress since phase 0), each annotated with the commit range. #168 stays In progress for wave 2.

- [ ] **Step 3: File the follow-up item** (board skill, Backlog): "Server-side guard for vehicles lock/share columns — `checkout_locked`/`open_checkout`/`locked_by` are accepted from any authed device (`syncPolicy.ts` vehicles INSERT/UPDATE: null); #157/#165/#167 rules are client-enforced only. Decide whether the sync push should authorize these columns (owner/manager + tier rule) like unit_access does."

- [ ] **Step 4: Deploy-lockstep reminder** (from the phase-0 handoff): the next API deploy auto-applies migrations 065/066; the day mobile ships, `open_checkout=0` defaults drop owner-assigned vehicles from other users' checkout availability — warn the crew before rollout.

---

## Self-Review (done at write time)

- **Spec coverage:** §1 debris → Tasks 1/4/5/6/7 (+ #159 verification in Task 9); §2 availability → Tasks 1/6/8 + edit-sheet rows in 5 + no-API-change confirmed (Global Constraints); §3 lock hierarchy → Tasks 1/2/3/5/6; §4 testing → Tasks 1/9. Spec's "add the server guard if phase 0 didn't" resolved as: no existing guard exists to mirror (table deliberately ungated) → follow-up board item (Task 10 Step 3) instead of new API scope.
- **Placeholder scan:** none — every code step carries complete code.
- **Type consistency:** `resolveVehicleAvailability`/`canLiftVehicleLock`/`snapDebrisLevel` signatures identical in Tasks 1/2/3/6/8; `canLiftVehicleLockFor(user, location, vehicle)` identical in Tasks 3/5/6; `VerticalLevelSlider` props identical in Tasks 4/6; `ensureVehicleRow` init identical in Task 7 both call sites.
