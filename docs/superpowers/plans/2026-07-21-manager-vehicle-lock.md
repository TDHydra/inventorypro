# Manager Vehicle Access & Checkout Lock (#165) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Production managers can lock/edit their team's vehicles; office/HR/franchise can reach the lock for any vehicle; tier-2 manager dashboards gain Vehicles/Lockers tiles.

**Architecture:** One new shared predicate `canManageVehicle` (owner ∥ tier≥3 ∥ tier≥2-and-shares-team-with-owner) in `access.ts` replaces the three hand-rolled owner-or-tier-3+ checks; a lock toggle pill is added to VehiclePanel's State card gated by that predicate (not `edit_inventory`); two tiles appended to the shared tier-2 layout. Client-only, no migrations, no server change (matches #157's client-enforced lock).

**Tech Stack:** React Native (Expo), op-sqlite (sql.js in tests), node:test + tsx with the repo's `Module._load` interception harness.

## Global Constraints

- Branch: `feature/role-dashboards`. Spec: `docs/superpowers/specs/2026-07-21-manager-vehicle-lock-design.md`. Board item: #165.
- JS-only — NO migrations, NO server changes, NO new dependencies.
- All commands run from `apps/mobile/` (repo root `/home/tdpotato/projects/InventoryPro`).
- Test runner: `pnpm test` (node:test over `src/**/*.test.ts`). Single file: `node --import tsx --import ./src/test/setupGlobals.mjs --test src/db/queries/vehiclesLock.test.ts`.
- Commit messages: `feat(#165): …` / `test(#165): …`, each ending with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.
- Do NOT edit `docs/BACKLOG-archive-2026-07-09.md`. Do NOT `git add -A` (working tree holds unrelated deliberate changes) — add named files only.

---

### Task 1: `canManageVehicle` predicate

**Files:**
- Modify: `apps/mobile/src/db/queries/access.ts` (add function directly below `canManageLockerAccess`, ~line 334)
- Test: `apps/mobile/src/db/queries/access.test.ts` (append tests at end of file)

**Interfaces:**
- Consumes: existing `sharesTeamWithOwner(userId, ownerUserId)` (same file), `ROLE_TIER` (already imported in access.ts), `UserSession` (`src/auth/permissions.ts`), `Location` type.
- Produces: `canManageVehicle(user: UserSession | null | undefined, location: Pick<Location, 'owner_user_id'> | null | undefined): boolean` — Tasks 2–3 import this exact name from `../../db/queries/access` / `./access`.

- [ ] **Step 1: Write the failing tests** — append to `access.test.ts` (the file's existing `before()` already creates `team_members` and seeds a real sql.js DB; `mkUser` may not exist — use the inline session literal below, matching the file's existing style):

```ts
// #165: canManageVehicle — owner ∥ tier>=3 ∥ tier>=2 sharing a team with the owner.
function session(id: string, role: string) {
  return { id, name: id, role, permission_overrides: {}, pin_length_required: 4, active: 1, expires_at: null } as never;
}

test('canManageVehicle: owner manages own vehicle regardless of tier', () => {
  assert.equal(access.canManageVehicle(session('crew-owner', 'mitigation_technician'), { owner_user_id: 'crew-owner' }), true);
});

test('canManageVehicle: tier-3 office manager manages ANY vehicle', () => {
  assert.equal(access.canManageVehicle(session('om-1', 'office_manager'), { owner_user_id: 'someone-else' }), true);
  assert.equal(access.canManageVehicle(session('om-1', 'office_manager'), { owner_user_id: null }), true);
});

test('canManageVehicle: tier-2 PM manages a vehicle owned by a teammate', () => {
  const db = testDb.getDb();
  db.executeSync(`INSERT INTO team_members (team_id, user_id) VALUES ('team-v', 'pm-1'), ('team-v', 'tech-owner')`);
  assert.equal(access.canManageVehicle(session('pm-1', 'production_manager'), { owner_user_id: 'tech-owner' }), true);
});

test('canManageVehicle: tier-2 PM does NOT manage other-team or unowned vehicles', () => {
  assert.equal(access.canManageVehicle(session('pm-1', 'production_manager'), { owner_user_id: 'stranger' }), false);
  assert.equal(access.canManageVehicle(session('pm-1', 'production_manager'), { owner_user_id: null }), false);
});

test('canManageVehicle: tier-1 crew non-owner never manages; null args false', () => {
  const db = testDb.getDb();
  db.executeSync(`INSERT INTO team_members (team_id, user_id) VALUES ('team-v', 'crew-2')`);
  assert.equal(access.canManageVehicle(session('crew-2', 'mitigation_technician'), { owner_user_id: 'tech-owner' }), false);
  assert.equal(access.canManageVehicle(null, { owner_user_id: 'x' }), false);
  assert.equal(access.canManageVehicle(session('pm-1', 'production_manager'), null), false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/mobile && node --import tsx --import ./src/test/setupGlobals.mjs --test src/db/queries/access.test.ts`
Expected: FAIL — `access.canManageVehicle is not a function`

- [ ] **Step 3: Implement** — in `access.ts`, directly below `canManageLockerAccess`:

```ts
/**
 * #165: vehicle management authority — lock/unlock checkout, bypass a lock,
 * edit state. Owner and tier-3+ (same as canManageLockerAccess), PLUS tier-2
 * managers for vehicles owned by someone on one of their teams ("their team's
 * vehicles" — the PM slice of the #156 device review).
 */
export function canManageVehicle(
  user: UserSession | null | undefined,
  location: Pick<Location, 'owner_user_id'> | null | undefined,
): boolean {
  if (!user || !location) return false;
  if (location.owner_user_id !== null && location.owner_user_id === user.id) return true;
  const tier = ROLE_TIER[user.role] ?? 0;
  if (tier >= 3) return true;
  return tier >= 2 && sharesTeamWithOwner(user.id, location.owner_user_id);
}
```

(`UserSession`, `Location`, `ROLE_TIER` are already imported by `canManageLockerAccess` — verify, add imports only if missing.)

- [ ] **Step 4: Run to verify pass** — same command. Expected: all tests PASS (existing + 5 new).

- [ ] **Step 5: Commit**

```bash
git add src/db/queries/access.ts src/db/queries/access.test.ts
git commit -m "feat(#165): canManageVehicle — owner/tier-3+/team-scoped tier-2 predicate

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: team-manager bypass in `isCheckoutLockedFor`

**Files:**
- Modify: `apps/mobile/src/db/queries/vehicles.ts:334-348` (`isCheckoutLockedFor`)
- Test: Create `apps/mobile/src/db/queries/vehiclesLock.test.ts`

**Interfaces:**
- Consumes: `sharesTeamWithOwner` from `./access` (new import in vehicles.ts); `canManageVehicle` NOT used here (this fn takes a bare userId, not a session).
- Produces: unchanged signature `isCheckoutLockedFor(locationId: string, userId: string | null): boolean` — now returns `false` for a tier-2 user sharing a team with the owner.

- [ ] **Step 1: Write the failing test** — create `vehiclesLock.test.ts` with the repo's standard harness (copy the `Module._load` block verbatim from `vehiclesTanks.test.ts` lines 1–36), then:

```ts
let veh: typeof import('./vehicles');

before(async () => {
  await testDb.initTestDb(); // creates locations/taxonomy_types/outbox
  testDb.getDb().executeSync(`
    CREATE TABLE vehicles (
      location_id TEXT PRIMARY KEY, truck_mount INTEGER NOT NULL DEFAULT 0,
      water_state TEXT, model TEXT, model_id TEXT, notes TEXT,
      water_tank TEXT NOT NULL DEFAULT 'empty', waste_tank TEXT NOT NULL DEFAULT 'clean',
      checkout_locked INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL, synced_at TEXT
    );
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT);
    CREATE TABLE team_members (
      team_id TEXT NOT NULL, user_id TEXT NOT NULL,
      is_manager INTEGER NOT NULL DEFAULT 0, subteam_id TEXT, subteam_role TEXT,
      PRIMARY KEY (team_id, user_id)
    );
  `);
  const db = testDb.getDb();
  // Vehicle 'van-1' owned by tech-owner, locked.
  db.executeSync(`INSERT INTO locations (id, name, type, owner_user_id, active, updated_at)
                  VALUES ('van-1', 'Van 1', 'Vehicle', 'tech-owner', 1, '2026-01-01')`);
  db.executeSync(`INSERT INTO vehicles (location_id, checkout_locked, updated_at)
                  VALUES ('van-1', 1, '2026-01-01')`);
  db.executeSync(`INSERT INTO users (id, name, role) VALUES
                  ('tech-owner','Owner','mitigation_technician'),
                  ('pm-team','PM','production_manager'),
                  ('pm-other','PM2','production_manager'),
                  ('om-1','Office','office_manager'),
                  ('crew-team','Crew','mitigation_technician')`);
  db.executeSync(`INSERT INTO team_members (team_id, user_id) VALUES
                  ('team-a','tech-owner'), ('team-a','pm-team'), ('team-a','crew-team'),
                  ('team-b','pm-other')`);
  veh = requireCjs('./vehicles') as typeof import('./vehicles');
});

test('locked vehicle: owner and tier-3 bypass (existing behavior)', () => {
  assert.equal(veh.isCheckoutLockedFor('van-1', 'tech-owner'), false);
  assert.equal(veh.isCheckoutLockedFor('van-1', 'om-1'), false);
});

test('locked vehicle: tier-2 PM sharing the owner team bypasses (#165)', () => {
  assert.equal(veh.isCheckoutLockedFor('van-1', 'pm-team'), false);
});

test('locked vehicle: other-team PM and same-team crew stay locked', () => {
  assert.equal(veh.isCheckoutLockedFor('van-1', 'pm-other'), true);
  assert.equal(veh.isCheckoutLockedFor('van-1', 'crew-team'), true);
  assert.equal(veh.isCheckoutLockedFor('van-1', null), true);
});

test('unlocked vehicle: never locked for anyone', () => {
  testDb.getDb().executeSync(`UPDATE vehicles SET checkout_locked = 0 WHERE location_id = 'van-1'`);
  assert.equal(veh.isCheckoutLockedFor('van-1', 'crew-team'), false);
  testDb.getDb().executeSync(`UPDATE vehicles SET checkout_locked = 1 WHERE location_id = 'van-1'`);
});
```

(If `initTestDb`'s `locations` table lacks an `owner_user_id`/`type` column, mirror whatever columns `vehiclesTanks.test.ts`/`access.test.ts` insert with — check their INSERTs and adapt; the SELECT under test only needs `id` + `owner_user_id`.)

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --import ./src/test/setupGlobals.mjs --test src/db/queries/vehiclesLock.test.ts`
Expected: `tier-2 PM sharing the owner team bypasses` FAILS (returns true today); the others pass.

- [ ] **Step 3: Implement** — in `vehicles.ts`, add import `import { sharesTeamWithOwner } from './access';` and change the tail of `isCheckoutLockedFor` from:

```ts
  if (!row || !row.checkout_locked) return false;
  if (userId != null && row.owner_user_id === userId) return false;
  return (ROLE_TIER[row.role as UserRole] ?? 0) < 3;
```

to:

```ts
  if (!row || !row.checkout_locked) return false;
  if (userId != null && row.owner_user_id === userId) return false;
  const tier = ROLE_TIER[row.role as UserRole] ?? 0;
  if (tier >= 3) return false;
  // #165: tier-2 managers pass for vehicles owned by someone on their team —
  // same team-scoped authority as canManageVehicle (kept in sync manually:
  // this path resolves from a bare userId, not a UserSession).
  return !(tier >= 2 && userId != null && sharesTeamWithOwner(userId, row.owner_user_id));
```

Also update the function's doc comment: owner / tier-3+ / same-team tier-2 manager bypass. Guard: if importing `./access` creates a require cycle (access.ts must not import vehicles.ts — verify with `grep -n "from './vehicles'" src/db/queries/access.ts`, expect no hits), keep the import; otherwise inline the same two-table COUNT query locally.

- [ ] **Step 4: Run to verify pass** — same command, all 4 tests PASS. Then full suite: `pnpm test` — no regressions (`vehiclesTanks.test.ts`, `access.test.ts`, `unitAccess.test.ts` all green).

- [ ] **Step 5: Commit**

```bash
git add src/db/queries/vehicles.ts src/db/queries/vehiclesLock.test.ts
git commit -m "feat(#165): team tier-2 managers bypass the vehicle checkout lock

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: wire the predicate into both vehicle surfaces + panel lock pill

**Files:**
- Modify: `apps/mobile/src/components/vehicles/VehicleEditSheet.tsx:55-58` (canLock seed)
- Modify: `apps/mobile/src/components/vehicles/VehiclePanel.tsx` (~line 111 `canBypassLock`; State card ~line 218; styles)

**Interfaces:**
- Consumes: `canManageVehicle` from `../../db/queries/access` (Task 1); existing `upsertVehicleState(locationId, patch, userId)` (`checkout_locked` already in `VehicleStatePatch`); existing `StatusPill`, `isWriteBlocked`.
- Produces: UI only — no exported API.

- [ ] **Step 1: VehicleEditSheet** — add `import { canManageVehicle } from '../../db/queries/access';`, then replace the `setCanLock` seed:

```ts
    setCanLock(!!user && (
      (location?.owner_user_id != null && location.owner_user_id === user.id)
      || (ROLE_TIER[user.role] ?? 0) >= 3
    ));
```

with:

```ts
    // #165: owner, tier-3+, or a tier-2 manager on the owner's team.
    setCanLock(canManageVehicle(user, location ?? null));
```

Update the comment block above `canLock` (line ~39) to say "owner / tier-3+ / same-team tier-2 manager (canManageVehicle)". Remove the `ROLE_TIER` import ONLY if now unused in the file (check other usages first).

- [ ] **Step 2: VehiclePanel bypass** — add `import { canManageVehicle } from '../../db/queries/access';`, then replace:

```ts
  const canBypassLock = !!user
    && (location.owner_user_id === user.id || (ROLE_TIER[user.role] ?? 0) >= 3);
```

with:

```ts
  // #165: shared predicate — owner / tier-3+ / same-team tier-2 manager.
  const canManage = canManageVehicle(user, location);
  const canBypassLock = canManage;
```

Update the `#157` comment above it. Remove the `ROLE_TIER` import only if unused after this.

- [ ] **Step 3: Panel lock toggle pill** — inside the State card, directly after the `truckRow` StatusPill block (`</View>` at ~line 224) and BEFORE the `{!!vehicle?.truck_mount && (` tanks block, add:

```tsx
        {/* #165: lock checkout from the panel — reachable for lock-managers
            (office/HR have no edit_inventory, so the Edit sheet is closed to
            them; this pill is their only toggle). Same write as the sheet. */}
        {canManage && !locked && (
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
        )}
```

Add to `makeStyles` (mirroring VehicleEditSheet's):

```ts
  toggleHint: { fontSize: t.typography.fontSizes.xs, color: t.colors.textMuted },
```

(`upsertVehicleState` is already imported by `setWaterTank`; `truckRow` style already exists. The State card comment at ~line 205 says tank writes are deliberately ungated — the lock pill is DIFFERENT: it stays behind `canManage`.)

- [ ] **Step 4: Verify** — `npx tsc --noEmit` from `apps/mobile` (expect clean), then `pnpm test` (all green — these are UI files, no unit tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/vehicles/VehicleEditSheet.tsx src/components/vehicles/VehiclePanel.tsx
git commit -m "feat(#165): panel lock-checkout pill + canManageVehicle on both vehicle surfaces

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: tier-2 dashboard tiles

**Files:**
- Modify: `apps/mobile/src/dashboard/roleLayouts.ts` (TIER2_MANAGER_LAYOUT, ends ~line 54)
- Test: `apps/mobile/src/dashboard/roleLayouts.test.ts` (append one test)

**Interfaces:** none new — layout data only.

- [ ] **Step 1: Write the failing test** — append to `roleLayouts.test.ts`:

```ts
// #165: every tier-2+ manager and crew dashboard surfaces Vehicles + Lockers.
test('tier-2 manager layouts include vehicles and lockers tiles (#165)', () => {
  for (const role of ALL_ROLES) {
    const tier = ROLE_TIER[role];
    if (tier < 1 || tier > 2 || role === 'temporary_employee' || role === 'office_manager') continue;
    const widgets = ROLE_DEFAULT_LAYOUTS[role]!.map(b => b.widget);
    assert.ok(widgets.includes('vehicles'), `${role}: vehicles tile`);
    assert.ok(widgets.includes('lockers'), `${role}: lockers tile`);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --import ./src/test/setupGlobals.mjs --test src/dashboard/roleLayouts.test.ts`
Expected: FAIL for production_manager/head_of_construction/head_of_contents/carpet_cleaning_manager (crew roles already pass).

- [ ] **Step 3: Implement** — append to `TIER2_MANAGER_LAYOUT` (after the `item-catalog` entry), matching CREW_LAYOUT's placement:

```ts
  // #165: managers see their team's vehicles/lockers (view inventory, edit
  // state, lock checkout via canManageVehicle).
  { widget: 'vehicles', width: 'half' },
  { widget: 'lockers', width: 'half' },
```

- [ ] **Step 4: Run to verify pass** — same command, all green. Then full `pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/roleLayouts.ts src/dashboard/roleLayouts.test.ts
git commit -m "feat(#165): vehicles + lockers tiles on tier-2 manager dashboards

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: device verification (hotload) — user-confirmed

**Files:** none (verification only). Metro is already serving this checkout; JS-only changes hot-reload.

- [ ] **Step 1:** Confirm Metro healthy: `curl -s http://localhost:8081/status` → `packager-status:running`; if the app was closed, cold-launch via `adb shell am start -a android.intent.action.VIEW -d "exp+inventorypro://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"`.
- [ ] **Step 2 (user, on S24):** PM login (121212 or 131313) → dashboard shows Vehicles + Lockers tiles → open a TEAM vehicle → tank controls editable, "Checkout open / 🔒 Locked" pill toggles; open an OTHER-team vehicle → no lock pill.
- [ ] **Step 3 (user):** Crew login (e.g. 414141, same team) → locked vehicle shows "🔒 Locked by owner" disabled checkout; owner still can.
- [ ] **Step 4 (user):** Admin 111111 (stands in for office/HR tier-3 reachability — no test office account in the roster; role screen can temp-assign if needed) → ANY vehicle → lock pill visible and toggles WITHOUT the Edit pencil requirement.
- [ ] **Step 5:** On user confirmation: `gh_done.py` #165, note DB-preset shadowing caveat (users with a saved user/role preset won't see new default tiles until preset cleared — known #156 gotcha).

## Self-Review

- Spec coverage: predicate (T1), isCheckoutLockedFor (T2), both surfaces + panel pill (T3), tiles (T4), verify-only items (T5 steps 2–4 cover team-inventory visibility and crew tiles implicitly). ✓
- No placeholders; all code shown. ✓
- Names consistent: `canManageVehicle`, `canManage`, `sharesTeamWithOwner`, `upsertVehicleState`. ✓
- Known judgment call encoded: office_manager excluded from the T4 test loop (tier-3, layout unchanged per user).
