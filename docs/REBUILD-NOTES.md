# Lean Rebuild — shared phase notes

Working notes for the mobile-v2/api-v2 rebuild (plan: 10 phases, branch
`lean-rebuild`). Kept current so parallel subagents can pick up context
without re-deriving it. Update the relevant section when your phase work
lands; reconcile, don't overwrite.

## Status

| Phase | State | Commits |
|---|---|---|
| 0 prep/guardrails | done | 661a93d |
| 1 packages/ui + core + manifest | done | 5231e49, 9a6b03f, 54828d0 |
| 2 mobile-v2 skeleton | done | 60ff9a3, 0399f3e |
| 3–10 | pending | — |

## Architecture facts (verified, don't re-derive)

- `packages/core` is platform-free: DB arrives via `setDbProvider(() => SqlDb)`,
  config via `configureCore({apiBase, generateUUID, auth, assertWritable?, track?})`.
  Config is read at call time — never capture it at module top.
- `SqlDb = {executeSync(sql, params?): {rows: any[]}; close()}`. op-sqlite's DB
  satisfies it directly; web wraps sql.js (`apps/mobile-v2/src/db/schema.web.ts`).
- ONE migrations index for both platforms:
  `apps/mobile-v2/src/db/migrations/index.ts`. Migration 001 = generated
  baseline from the manifest (`baselineDdl()`); `tableDdl` emits
  `CREATE TABLE/INDEX IF NOT EXISTS` because the runner bootstraps
  `app_settings` (schema_version watermark) before 001 runs.
- Sync triggers are injected: `startSyncEngine(appSyncTriggers)` — NetInfo +
  AppState in `src/sync/triggers.ts` (`netinfo.web.ts` shims navigator.onLine).
- Post-pull refreshers register via `registerAfterPull({name, tables?, run})`.
  Phase 2 registers only rolePermissions on `['role_settings']` (in `src/boot.ts`).
- `getOutboxCounts()` returns `{active, failed}`; denied entries are a separate
  bucket via `getDeniedOutbox()`.
- Root layout remounts the whole Stack on theme change (`key={theme.id}`) —
  navigation state resets to the index route when the theme switches. Known,
  accepted for now.

## Contract gotchas (cost real debugging time)

- **activity_log `login`/`pin_set` are serverOnly**: `/auth/token` writes the
  authoritative row; a client push of these actions is permanently denied
  (`NOT_ALLOWED`). v2's finishLogin therefore writes NO client login log — the
  old app's did and accumulated one denied outbox entry per login. Don't
  reintroduce it. Other appendLog actions push fine.
- `EXPO_PUBLIC_*` env vars inline at bundle time and Metro caches transforms:
  changing them requires `expo export --clear` (or `expo start -c`).
- expo serve of a web export has no SPA fallback — deep links 404; enter at `/`.
- PG enum columns are TEXT on mobile; never remap without ALTER-to-TEXT.
- bcrypt hashes (`$2b$...`) corrupt inside double-quoted shell strings.

## Dev environment (local, mirrors prod contract)

- PG: docker `invenpro-dev-pg`, postgres:16-alpine on 127.0.0.1:5433,
  user/db `invenpro`/`inventorypro`, pw `devlocal`; restored from
  `~/archive/InventoryPro-artifacts/prod-dump-2026-09-21.sql.gz`.
- API: old apps/api via tsx on **:3001** (NOT :3000 — stale root-owned Sep21
  processes hold :3000 with an old build; leave them). Env: DATABASE_URL to
  :5433, dev JWT secret, MINIO stub creds, CORS for localhost:8081/8082.
- Dev user: "Dev Tester", full_admin, PIN 4242,
  id `fca1237e-8397-4a91-8f01-26f2ca3fa3db` (dev DB only).
- Web smoke: `npx expo export --platform web --clear` then `npx expo serve dist`
  on :8081.
- Device dev build: `APP_VARIANT=development` → applicationId
  `com.inventorypro.app.v2`, name "InventoryPro Dev", no google-services /
  expo-notifications plugin (coexists with the prod app). Local build:
  `expo prebuild --platform android` + `./gradlew assembleDebug`.
  USB device + `adb reverse` lets the device use localhost URLs.

## Verified so far (Phase 2 exit, 2026-09-22)

Both targets green against the local dev API + prod-dump PG:

- **Web**: fresh client → roster → PIN login (bcrypt→JWT) → full download of
  all 37 tables (counts match prod dump) → theme write → outbox push (row
  landed in dev PG) → pull watermark advanced. Denied bucket verified via the
  (since removed) client login log.
- **Device** (Galaxy S24 Ultra, debug dev-client APK installed alongside the
  prod app): login → full download → live counts identical to web → theme
  writes push to PG within seconds → server-pulled user theme applies at
  login. Denied count 0 (finishLogin fix confirmed on-device).
- **Hotload**: metro fast refresh works, BUT metro must NOT be started with
  CI=1 — that silently disables file watching (no rebundle on edit). Start it
  under a pty (`script -qefc "... npx expo start --port 8082" /dev/null`) or
  a real terminal.
- Device networking: `adb reverse tcp:8082 tcp:8082` + `tcp:3001 tcp:3001`,
  launch dev client via
  `inventorypro://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8082`
  — an "Open with" chooser appears (prod app shares the scheme); pick
  "InventoryPro Dev".

## Wave A progress

Foundation landed (repos + shared components; screens next):

- `src/repos/`: items, search, suggestions, locations, rooms, taxonomy,
  equipment, equipmentUnits, maintenance, labelResolve, jobs (READ-ONLY stub
  for search/pickers — full jobs repo is Wave C), + testDb harness and tests.
  Repos self-mirror to the outbox; components/screens must NOT call
  `appendOutbox` after a repo write (double-write bug — already caught and
  fixed once). Legit direct appendOutbox callers: `src/db/{formMode,
  hiddenFields,mainStorage}.ts` (app_config, no repo) and one raw-SQL delete
  path in QuickAddEditSheet.
- `src/components/`: ItemCard, Barcode{Input,Scanner(+.web)}, USBScanner,
  SearchablePicker, TooltipHint, PermissionGate, QuickAddBanner,
  LocationSuggestionBanner, UnitRow, MoveStockModal, GpsAnchorField,
  MapDisplay/MapPickerModal/leafletAssets, CsvImport, pickers/ (whole dir),
  quickadd/ (shell + item/location/stock/equipment sheets + stockGates),
  ui/{AdvancedFields,AutofillTextField,HidableField} + their hooks/constants.
  SuggestInput/BulkActionBar/quickAddBanner-lib/typeColors NOT copied — they
  live in `@invenpro/ui`.
- TODO markers to honor in later waves: `TODO(wave-media)` (MediaThumbnail/
  Gallery cut from ItemCard/ItemQuickAdd), `TODO(wave-chat)` (PermissionGate
  request-access DM → toast), `TODO(wave-B)` (QuickCreateSheet vehicle/job/
  repair/team/user kinds return null; typed-route casts to unbuilt screens),
  `TODO(gap)` (queries/access.ts unit-inventory lock stubbed always-unlocked
  at 4 call sites — server enforcement unaffected; 381-ln module to port with
  the access surface in Wave B).
- Verified: `pnpm --filter mobile-v2 typecheck` clean; mobile-v2 unit tests
  40/40; `@invenpro/core` 181/181.
- A fork stray-edited `apps/mobile/src/components/BarcodeScanner.web.tsx`
  (syntax-breaking garbage) — reverted via git checkout; v2 copy verified
  clean. Old app is READ-ONLY: re-check `git status apps/mobile` after any
  subagent wave.

Screens landed (all six Wave A surfaces; typecheck clean, 40/40 + 181/181):

- Routes are PLAIN dirs under `app/(app)/` (no parens groups): `inventory/
  {index,[id],low-stock}`, `locations/{index,[id]}`, `equipment/{index,[id]}`,
  `manage-types`, `scan`, `checkout`, `quickadd/{index,[sheet]}`. Hub stub
  gained a 7-tile grid (real role hub is Wave D).
- checkout.tsx (1600 ln) absorbs the old checkin screen as a CheckinPanel
  mode; no checkouts table exists — state derives from activity_log/stock/
  units via existing repos. jobs.ts stays READ-ONLY (got ActiveCheckout +
  getActiveCheckoutsForUser).
- quickadd/[sheet] is ONE dynamic route for all kinds; wave-B/C kinds render
  disabled tiles / "coming soon". ItemQuickAdd reads a `barcode` param;
  StockQuickAdd reads a `locationId` param (added for locations' "+ Add Stock
  Here" — the old (inventory)/add.tsx was NOT ported, quickadd replaces it).
- equipment gained a model-wide Maintenance Timeline
  (getMaintenanceEventsForItem in repos/maintenance.ts) and a
  NewEquipmentModelSheet on index (gap: no sheet could create a kind:
  'equipment' model).
- locations detail's "rooms" = sub-areas via repos/locations.getRoomsForParent;
  repos/rooms.ts is the separate room-catalog table (photo tagging).
- Remaining intentional `as never` casts: ONLY the three `/(app)/repairs/new`
  pushes (ItemCard, equipment/[id], locations/[id]), tagged TODO(wave-C).
  Wave C MUST sweep them when repairs lands.
- `.expo/types/router.d.ts` (typed routes, gitignored) is regenerated ONLY by
  a real metro dev server run (`expo start`, pty, no CI=1) — `expo export`
  does NOT reliably regenerate it. If new routes throw TS2322 route-type
  errors, run metro briefly, then typecheck.

### Wave A checkpoint (2026-09-22)

- **Web smoke PASS** (export → expo serve :8081 → real browser): roster → PIN
  login → hub tiles → inventory list → ItemCard → item detail → Adjust modal
  → local reactive update → **outbox push landed in dev PG** (stock 3→4 +
  adjust_stock activity row). Note: the push is debounced — a PG check right
  after the write can race it; wait/recheck before calling it a failure.
- **Device hotload pass PENDING**: `adb devices` empty (S24 Ultra unplugged).
  Run it when the phone is back: adb reverse 8082+3001, metro under pty,
  dev-client deep link. Wave B work does not block on this.
- Cosmetic backlog for Wave D hub: tile grid (31% width, aspectRatio 1) is
  oversized on desktop web viewports.
- A file was mangled ON DISK post-commit (StockQuickAdd.tsx — all inline
  comments hoisted to the top, code unchanged; source unknown, possibly a late
  agent flush). Reverted via git checkout. After any agent completes, check
  `git status` for unexpected modifications before building on top.

## Wave B progress

### Station B1 — Users + Roles (2026-09-22)

- `src/repos/users.ts` + `src/repos/roleSettings.ts`: split out of the
  Phase-2-built `src/db/queries/users.ts` (which bundled both domains with
  hand-rolled `appendOutbox` calls, predating the repo convention) — that file
  is now deleted; all ~10 importers repointed. Both repos build on
  `createRepository('users' | 'role_settings')`.
  - `role_settings` writes ALWAYS use `.mirror('UPDATE', payload, localWrite)`
    with the old app's exact `INSERT ... ON CONFLICT(role) DO UPDATE SET
    <touched-cols>` upsert preserved in `localWrite` — a role_settings row
    isn't guaranteed to exist locally for every role (no local seed
    migration), so a plain `.update()` would silently no-op, and a full-row
    `INSERT OR REPLACE` would reset every unlisted column to its default.
  - `users` writes: reads unchanged; PIN-touching operations
    (`createUserOnline`, `resetUserPinOnline`, `resetEnrollmentCodeOnline`,
    `changeRoleOnline`) stay online-only REST round-trips (server owns
    pin_hash/pin_set/enrollment_code_hash — `USERS_ALWAYS_DENY` in
    `apps/api/src/lib/syncPolicy.ts` blocks them on the outbox entirely) with
    local-only mirroring (`queueTableBump`, no outbox — the server already has
    the row); `setUserActive`/`saveUserFields`/`setUserRole` go through
    `.update()`/`.mirror()`; `permission_overrides` uses `.mirror()` +
    `JSON.stringify()` in `localWrite` (TEXT locally, object over the outbox —
    same split as `role_settings.permission_overrides`).
  - No repo function calls `appendLog` — callers wrap
    `runInTransaction(() => { repoFn(...); appendLog({...}); })` themselves,
    exploiting `runInTransaction`'s reentrancy, exactly mirroring both old
    screens' structure.
  - `pin_set`/`login` still never client-logged (existing Wave A rule, just
    re-verified here — server writes the authoritative row on the same PIN
    request).
- Screens: `app/(app)/users/index.tsx` (list + search + multi-select bulk
  deactivate/reactivate/change-role/reset-PIN + create modal + edit sheet with
  PIN reset / access-code reset / permission overrides) and
  `app/(app)/roles/index.tsx` (collapsible role cards, min-PIN stepper, idle
  re-auth selector, color swatches, grouped permission matrix with
  impact-preview confirms, "Preview as…" picker) — both straight ports of
  `apps/mobile/app/(app)/(admin)/{users,roles}.tsx`.
- `src/components/quickadd/UserQuickAdd.tsx` ported (name + role only, no
  PIN, live duplicate-name search); wired into `QuickCreateSheet.tsx` and the
  quickadd hub/dynamic route (`quickadd/index.tsx`, `quickadd/[sheet].tsx`) —
  the `'user'` `TODO(wave-B)` markers in both are now resolved.
- `src/components/PreviewBanner.tsx` ported (lives under `src/components/`,
  not `@invenpro/ui` — packages/ edits aren't authorized for this station) and
  mounted in `app/_layout.tsx` above the theme-keyed `<Stack>`. The "Preview
  as…" role-preview plumbing (`previewRole`/`deriveEffectiveUser`/
  `setPreviewWriteBlock`) already existed since Phase 2 explicitly awaiting
  "a screen" — roles/index.tsx is that screen now.
- `app/(app)/index.tsx` (hub stub) gained two permission-gated tiles (Users →
  `manage_users`, Roles → `manage_roles_permissions`) — the only entry point
  to the new screens until the real role-based hub lands in Wave D.
- **Cut this station** (unported domains / explicit cut-list, each with a
  marker so the right later wave picks it up):
  - Dashboard preset assignment (users edit sheet + roles screen) — dashboard
    preset engine is cut entirely per the coordinator's cut-list.
  - Personal locker toggle (users edit sheet) — depends on the unported
    `src/access/unitGrants.ts` domain; same class as `locations.ts`'s
    `TODO(gap)` unported vehicle helpers.
  - Message/DM button (users list) — `TODO(wave-chat)`.
  - Bulk "Add to team" action (users list) — `TODO(wave-B)`, a later Wave B
    station owns `src/repos/teams.ts`.
- `.expo/types/router.d.ts` regenerated via a pty metro run (per the known
  trap) to pick up the two new plain routes `/(app)/users` and `/(app)/roles`.
- Verified: `pnpm --filter mobile-v2 typecheck` clean; unit tests still
  40/40 (no new tests added for the two new repos this station — a gap to
  close, not a regression: no existing test exercises `db/queries/users.ts`'s
  successor either). `git status --short apps/mobile` empty throughout.

### Station B2 — Teams + Subteams + My Team + Crew (2026-09-22)

- `src/repos/teams.ts` (new, ~420 lines): one repo file for `teams` +
  `team_members` + `subteams` (old app split these across
  `db/queries/teams.ts` + `db/queries/subteams.ts`), built on
  `createRepository('teams' | 'team_members' | 'subteams')`.
  - `SqlDb.executeSync` (`packages/core/src/db/provider.ts`) has no
    `rowsAffected` field, unlike old app's op-sqlite wrapper. Every old-app
    `res.rowsAffected < 1` check (dedup on `addTeamMember`, membership
    existence in `setSubteamMembership`/`clearSubteamMembership`) is adapted
    to a `SELECT ... LIMIT 1` existence check performed BEFORE the write —
    documented in a top-of-file comment.
  - `createTeam`/`updateTeam` dual-write the `type_id` taxonomy FK (resolved
    via `resolveTypeId`) locally but exclude it from the outbox payload,
    exactly mirroring `locations.ts`'s `upsertLocation` precedent — the
    server resolves/owns `type_id` from the pushed label.
  - `TEAM_OVERRIDABLE_PERMISSIONS` is NOT redefined here — it was pre-staged
    in `src/auth/teamPerms.ts` ahead of this station and is already consumed
    by `auth/session.ts`'s `buildTeamContexts`; `repos/teams.ts` imports and
    re-exports it. `TEAM_PERMISSION_LABELS` (the display-label map) is new.
  - Subteam functions (`createSubteam`/`renameSubteam`/`setSubteamMembership`/
    `clearSubteamMembership`/`deleteSubteam`) do **not** call `appendLog`
    internally — unlike old app's `db/queries/subteams.ts`, which logged
    inside the query layer. This follows the repo-layer convention set in B1
    (repos never call `appendLog`; callers wrap
    `runInTransaction(() => { repoFn(...); appendLog({...}); })`). Every
    screen that calls a subteam function (`teams/[id].tsx`, `myteam.tsx`) now
    owns those `appendLog` calls itself, using the `{team_id, name/oldName,
    memberUserIds}` the repo functions return for exactly that purpose.
  - `reconcileTeams()`: full port of `apps/mobile/src/sync/teamPurge.ts`,
    using `@invenpro/core`'s existing `getAppSetting`/`setAppSetting`/
    `deleteAppSetting` (not hand-rolled SQL against `app_settings` like the
    old app's local `getFlag`/`setFlag`/`clearFlag`). Registered in
    `src/boot.ts` via `registerAfterPull({ name: 'reconcileTeams', run: async
    () => { await reconcileTeams(); } })` with no `tables` filter (must run
    every pull cycle — own internal 60-min throttle — mirroring the old
    engine's hardcoded per-pull call). Deliberately does NOT call
    `resetLocalDb()` (would drop the outbox / unpushed offline edits).
- Screens: `app/(app)/teams/index.tsx` (My Teams / All Teams list + create
  modal, org-authority tier gate), `app/(app)/teams/[id].tsx` (roster,
  promote/demote manager, per-member perms, full Crews CRUD inline), and
  `app/(app)/myteam.tsx` (renamed from old app's `(myteam)/index.tsx` — no
  group folder left to carry the name) — scoped to ONLY the "My Crews"
  section. All three are straight ports of
  `apps/mobile/app/(app)/(teams)/{index,[id]}.tsx` and
  `apps/mobile/app/(app)/(myteam)/index.tsx`.
- `src/components/crew/{CrewCard,CrewEditor}.tsx` ported ~verbatim (import
  paths only). `src/components/crew/MemberPermissionsSheet.tsx` ported scoped
  down to ONLY the team-permission-overrides section (see cuts below).
- `src/components/quickadd/TeamQuickAdd.tsx` ported; wired into
  `QuickCreateSheet.tsx` (`'team'` case, was a `TODO(wave-B)` stub) and the
  quickadd hub/dynamic route (`quickadd/index.tsx`, `quickadd/[sheet].tsx`) —
  un-deferred the "Team" tile.
- `app/(app)/index.tsx` (hub stub) gained a `Teams` tile (gated on
  `view_teams`, matching the screen's own `PermissionGate` — not
  `manage_teams`) and a `My Team` tile (ungated, in the plain `TILES` list —
  `myteam.tsx` has no permission gate of its own; crew membership IS the
  gate, data-driven).
- **Scope decision — flag to next station**: `apps/mobile/app/(app)/(crew)/index.tsx`
  is **not** subteam/crew management — it's an unrelated "fast checkout
  source picker" (#127) depending on unbuilt vehicle/locker/unit_access
  systems. No `app/(app)/crew.tsx` was created. The "Crew" charter is instead
  satisfied by Subteams promoted to a real surface inside `teams/[id].tsx`
  (full CRUD) and `myteam.tsx`'s "My Crews" section — matching the brief's
  own wording ("subteams promoted to a real surface... inside team detail").
- **Cut this station** (unported domains / explicit cut-list, each with a
  marker so the right later wave picks it up):
  - `MemberPermissionsSheet`'s per-unit access grants section and personal
    locker toggle — `TODO(gap)`, depends on the unported
    `src/db/queries/access.ts` / `unitAccess.ts` / `access/unitGrants.ts` /
    `access/personalLocker.ts` domain, same class as B1's/locations.ts's cuts.
  - `myteam.tsx`'s "My Lockers" section — `TODO(gap)`, same access domain.
  - `myteam.tsx`'s "My Vehicles" section — `TODO(wave-C)`, vehicles aren't
    ported at all yet.
  - Message-member button on `teams/[id].tsx`'s roster — `TODO(wave-chat)`,
    chat isn't ported yet.
- Swept two TODOs this station made obsolete:
  - `users/index.tsx`'s bulk "Add to team" — was `TODO(wave-B-teams)`, now a
    real `BulkAction` (team picker modal → `addTeamMember` per selected user,
    one transaction, `team_member_added` log entries, skips already-members
    with no outbox/log churn).
  - `QuickCreateSheet.tsx`'s `'team'` case — was a `TODO(wave-B)` stub
    (`return null`); now renders `TeamQuickAdd`. The sibling `vehicle`/`job`/
    `repair` stubs were relabeled `TODO(wave-C)` (they were `TODO(wave-B)`
    but are not this station's domain).
- **Test debt closed** (flagged in B1): added `src/repos/users.test.ts` (11
  tests), `src/repos/roleSettings.test.ts` (7 tests), and
  `src/repos/teams.test.ts` (15 tests, incl. 3 `reconcileTeams` tests against
  a mocked `globalThis.fetch`) using the existing `testDb.ts` harness
  (`rooms.test.ts`/`locationsShelf.test.ts` precedent). Total suite: 72/72
  passing (was 40/40 after B1).
- `.expo/types/router.d.ts` regenerated twice via pty metro runs (per the
  known trap) — once for `/(app)/teams` + `/(app)/teams/[id]`, again for
  `/(app)/myteam`.
- Verified: `pnpm --filter mobile-v2 typecheck` clean; `pnpm --filter
  mobile-v2 test` 72/72 green. `git status --short apps/mobile` empty
  throughout.

### Station B3 — Access + Approvals (2026-09-22)

- `src/repos/access.ts` (new, ~330 lines): one repo file for `unit_access`,
  merging old app's `db/queries/access.ts` (381 ln) + `db/queries/
  unitAccess.ts` + `access/unitGrants.ts`, built on
  `createRepository('unit_access')`. Supporting pure files kept separate
  (matches old app's own split): `src/access/unitAccessPolicy.ts`
  (`canManageUnitAccess`, verbatim), `src/db/unitAccessDefaults.ts`
  (read-only trim of the per-role defaults reader — see cuts below).
  - **Scope this station**: Vehicle-coupled surfaces are OUT — vehicles
    aren't ported to mobile-v2 at all. Cut from the port:
    `getAccessibleSourceLocations`, `getTeamUnits`, `getCheckoutSourceLocations`,
    `getVisibleUnits`, `canManageVehicle`, `canLiftVehicleLockFor` —
    `TODO(wave-C)`, same wave as `locations.ts`'s unported vehicle helpers.
    `getGrantableUnits` is trimmed to Locker-type units only (was
    `Vehicle ∪ Locker`). `getAllUnitAccessGrants` is a NEW function (no old
    app equivalent) added to back `access/index.tsx`, filtered to active
    Locker units.
  - **Self-log convention (DIVERGENCE from the old app)**: old app's
    `upsertUnitAccess`/`revokeUnitAccess` called `appendLog` internally
    (`unit_access_granted`/`unit_access_revoked`). Following the same
    convention B1/B2 established (repos never self-log), this port's
    `upsertUnitAccess`/`revokeUnitAccess`/`grantUnitAccessWithDefaults` do
    NOT call `appendLog` — every caller (`MemberPermissionsSheet.tsx`,
    `myteam.tsx`'s My Lockers, `access/index.tsx`) wraps
    `runInTransaction(() => { repoFn(...); appendLog({...}); })` itself,
    using the exact old action names/metadata shapes documented on each
    repo function.
  - Outbox payload booleans: raw JS booleans (not `0`/`1`), matching B2's
    `addTeamMember` precedent — `bindParams` converts to 0/1 for the local
    write; the outbox JSON round-trips `true`/`false` fine server-side. This
    diverges from the old app's explicit `b(v) => v ? 1 : 0` helper, which is
    unnecessary here.
  - `src/repos/approvals.ts` (new, ~115 lines): `createRepository('approval_requests')`,
    ported from the approvals half of old app's `db/queries/notifications.ts`
    (the notifications-inbox half — `listNotifications`/`countUnread`/
    `markRead`/`markAllRead` — is OUT OF SCOPE, no standalone inbox is
    planned). Routed through `.insert()`/`.update()` rather than hand-rolled
    writes. One small, harmless divergence: old app's `decideApproval`
    deliberately omitted `updated_at` from its outbox UPDATE payload ("the
    server bumps updated_at"); `createRepository.update()` always
    auto-touches `updated_at` when absent, so this port's outbox payload DOES
    carry a client `updated_at` — the server remains authoritative regardless.
    `decideApproval` was confirmed to never self-log in the old app either
    (no `appendLog` call anywhere near it) — no divergence, no caller-owned
    log needed for approve/deny.
- Un-stubbed every `TODO(gap)` this module unblocks:
  - The 4 original always-unlocked stubs (`StockQuickAdd`, `ItemQuickAdd`,
    `EquipmentQuickAdd`, `MoveStockModal`) now call
    `getUnitInventoryLockForUserId`/`getUnitInventoryLock` (#162 team-scoped
    unit inventory lock).
  - `MemberPermissionsSheet.tsx`: restored the "Unit access" grants section
    (per-action switches, revoke, grant-new-unit picker) and "Personal
    locker" toggle, verbatim from the old app's structure with the
    self-log divergence applied (`toggleUnitAction`/`handleRevoke`/
    `handleGrantUnit` each own an `appendLog` call now).
  - `myteam.tsx`: restored "My Lockers", SIMPLIFIED vs. the old app — the old
    `LockerSheet` (full `LockerPanel` + "Open full page" route) is cut;
    tapping a locker here opens the generic `AccessListEditor` directly
    (grant/revoke who can access it) since a dedicated locker detail route
    isn't part of this wave.
  - `users/index.tsx`: restored the personal-locker toggle in the edit-user
    sheet (gated `manage_locations`), same pattern as
    `MemberPermissionsSheet`'s toggle.
- NEW surfaces (no old-app equivalent for either):
  - `app/(app)/access/index.tsx` — admin surface for `unit_access`: list
    every grant across active Locker units (`getAllUnitAccessGrants`),
    filter by locker/person, grant (locker + person picker) / revoke, gated
    `manage_locations` (`PermissionGate mode="screen"`).
  - `app/(app)/approvals/index.tsx` — pending-approvals worklist
    (`listOpenApprovals`), approve/deny via `decideApproval`. There's no
    dedicated "approver" permission in the role model (the server resolves
    approvers per-request); decide actions are courtesy-gated on
    `manage_teams` (closest existing "authority over people" permission) —
    the server remains the enforcement of record.
  - `app/(app)/index.tsx` hub gained "Access" (`manage_locations`) and
    "Approvals" (`manage_teams`) tiles in `ADMIN_TILES`.
  - `RequestApprovalSheet.tsx` (verbatim port) wired into
    `inventory/[id].tsx` and `equipment/[id].tsx` at their `TODO(wave-chat)`
    "Request Approval" markers (the sheet itself has no chat dependency —
    only `DiscussThisButton`/DM remain `TODO(wave-chat)` on those screens).
- **Cut this station** (unported domain, marker so the right later wave
  picks it up):
  - `src/db/unitAccessDefaults.ts`'s admin per-role defaults TEMPLATE EDITOR
    (the setter + version/listener pair + the `(admin)/unit-access-defaults.tsx`
    screen) — `TODO(wave-C)`. Only the read-only getter is ported; every new
    grant resolves to `FALLBACK_ACTIONS` until that admin screen lands.
- Test debt closed: added `src/repos/access.test.ts` (16 tests, incl. 5
  `getUnitInventoryLock`/`ForUserId` scenarios) and `src/repos/
  approvals.test.ts` (7 tests) using the existing `testDb.ts` harness. Total
  suite: 95/95 passing (was 72/72 after B2).
- `.expo/types/router.d.ts` regenerated via a pty metro run for
  `/(app)/access` + `/(app)/approvals`.
- Verified: `pnpm --filter mobile-v2 typecheck` clean; `pnpm --filter
  mobile-v2 test` 95/95 green. `git status --short apps/mobile` empty
  throughout.

### Station B4 — Notifications + Logs (2026-09-22)

**This was the LAST porting station of Wave B.**

- `src/repos/notifications.ts` (new): `createRepository('notifications')`,
  ported from the notifications-inbox half of old app's
  `db/queries/notifications.ts` (`listNotifications`/`countUnread`/
  `markRead`/`markAllRead`/`NotificationRow`). The approvals half of that
  same old file was already ported to `repos/approvals.ts` in B3 — not
  re-ported here.
  - `markRead` divergence handled byte-for-byte rather than accepted: the old
    app's local UPDATE sets both `read_at` and `updated_at`, but its outbox
    payload is a minimal `{ id, read_at }` diff ("the server stamps
    `updated_at`"). Unlike B3's `decideApproval` (which accepted
    `createRepository.update()`'s auto-touched `updated_at` as a harmless
    divergence), here we used the repo's `.mirror()` escape hatch with a
    hand-written local UPDATE + an exact `{ id, read_at }` outbox payload, so
    the wire payload matches the old app exactly.
  - `notifications` manifest: `sync: 'both'`, `scope: 'own-user'`,
    `fullDownload: true` — already present in `packages/core/src/manifest/
    tables.ts`, no manifest change needed.
- `app/(app)/notifications/index.tsx` (new route, plain dir): ported from old
  `(notifications)/index.tsx`. Imports `getApprovalRequestById`/
  `decideApproval` from the EXISTING `repos/approvals.ts` rather than
  re-porting them. `reloadKey`/`dataVersion` manual-refresh plumbing replaced
  with `@invenpro/core`'s `useDbQuery` (matches B3's `approvals/index.tsx`
  idiom). `navigateTo()`'s deep-link switch trimmed to only the `inventory`
  case — `repairs`/`jobs`/`media` destinations aren't ported to mobile-v2 yet,
  so those cases are cut (falls through to "stay on the inbox", same as the
  old app's default case).
- `NotificationBell` restored (`src/components/NotificationBell.tsx`, wired
  into `app/(app)/_layout.tsx`'s `headerRight`, ahead of Switch/Sign out) —
  this is "how the old app exposed it" (a header bell with an unread badge,
  not a hub tile). `ChatBell`/`SyncIndicator`/quick-photo stay cut (their own
  waves).
- `ActivityFeed` restored (`src/components/ActivityFeed.tsx`) — ported from
  the old 236-line component, SLIMMED: the trailing photo thumbnail + full-
  screen lightbox (`getPrimaryMedia`/`getMediaForEntity`) is cut — `src/db/
  queries/media.ts`/the media domain isn't ported to mobile-v2 yet
  (`TODO(wave-media)`, matches the existing cut in `ItemCard.tsx` and
  `locations/[id].tsx`'s Photos section). `ACTION_ICONS`/`actionLabel` are
  exported as the single source of truth (same role as the old app), reused
  by the new logs screen. Wired into `locations/[id].tsx`'s Activity section
  (the only detail screen that had an explicit `TODO(wave-B)` Activity stub —
  `inventory/[id].tsx`'s ActivityFeed is already tagged `TODO(wave-media)`
  because the old screen paired it with `PriorRepairsCard` inside the same
  History modal; `equipment/[id].tsx`'s ActivityFeed was a prior deliberate
  CUT, not a deferred marker — neither was touched this station).
- **LOGS — read-only, simplified by design** (`app/(app)/logs/index.tsx`,
  new route): the old `(logs)/index.tsx` is 751 lines and, on inspection,
  its "My Activity"/"Pending Sync" tabs are pure local reads but its "All
  Activity"/"My Team" tabs required a live `GET /logs` server round-trip
  with server-side joins, a `SearchablePicker` cascade, a map-detail modal
  (`MapDisplay`), and photo thumbnails (`MovePhotoThumb`/
  `ActivityLogDetail`) — none of that online/map/photo infra exists in
  mobile-v2. Confirmed via the manifest that `activity_log`'s `sync` mode is
  `push-only` (never pulled from the server), so the local table can in fact
  ONLY ever hold rows this device itself wrote — the "All Activity"/"My Team"
  tabs' premise (reading OTHER users' activity) is structurally impossible
  without that server round-trip. Per the brief's explicit permission ("if
  the old (logs) route IS the dropped audit viewer, build a minimal
  read-only activity list instead and document the divergence"), this port
  is a minimal list: "My Activity" (local `getLogFiltered`, scoped to the
  signed-in user, with action/entity-type `SearchablePicker` filters + an
  in-memory name/note search) and "Pending Sync" (`getUnsyncedLogs`) — the
  two tabs that were always pure local reads. "All Activity"/"My Team" and
  the map/photo affordances are CUT, not silently dropped. Confirmed
  `src/db/queries/log.ts`'s read helpers (`getLogFiltered`, `getLogNameMaps`,
  `resolveEntityName`, `getUnsyncedLogs`, etc.) were ALREADY fully present in
  mobile-v2 (331 lines, identical to the old app) from an earlier station —
  no read-helper porting needed, just the screen.
- Hub wiring: added an ungated "Activity Log" tile to `app/(app)/index.tsx`'s
  `TILES` (same tier as My Team — it only ever shows the signed-in user's own
  rows, so no permission gate applies).
- Marker sweep — retagged every remaining `TODO(wave-B)` marker (not mine to
  resolve this station) per the coordinator's mapping:
  - `src/repos/locations.ts:576` (vehicle Archive action) → `TODO(wave-C)`.
  - `app/(app)/locations/[id].tsx`'s VehiclePanel/LockerPanel comment +
    inline stub → `TODO(wave-C)`.
  - `app/(app)/locations/[id].tsx`'s LabelPrintSheet comment + inline stub →
    `TODO(wave-D)`.
  - `app/(app)/equipment/[id].tsx`'s header-comment line + `doRepairIn`'s
    inline comment (repair-ticket auto-complete) → `TODO(wave-C)`.
  - `grep -rn "TODO(wave-B)" apps/mobile-v2` now returns ZERO hits — Wave B's
    marker cleanup is complete.
- Test debt closed: added `src/repos/notifications.test.ts` (5 tests,
  including one that asserts the `markRead` outbox payload is EXACTLY
  `{id, read_at}` — no `updated_at` leak). Total suite: 100/100 passing (was
  95/95 after B3).
- `.expo/types/router.d.ts` regenerated via a pty metro run for
  `/(app)/notifications` + `/(app)/logs`.
- Verified: `pnpm --filter mobile-v2 typecheck` clean; `pnpm --filter
  mobile-v2 test` 100/100 green. `git status --short apps/mobile` empty
  throughout.

**Wave B is now complete** (Stations B1 Users+Roles, B2 Teams+Crew, B3
Access+Approvals, B4 Notifications+Logs) — zero `TODO(wave-B)` markers remain
anywhere in `apps/mobile-v2`.

### Wave B checkpoint (2026-09-22)

- `pnpm -r test` green across the workspace: api 586, old mobile 947,
  mobile-v2 100, core 181, ui 110 (exit 0).
- Web export smoke PASS: fresh `expo export --platform web` served on :8081.
  **Trap hit:** plain `expo export` bakes `EXPO_PUBLIC_API_URL`'s DEFAULT
  (`localhost:3000`) into the bundle → login roster 404s. Always export with
  `EXPO_PUBLIC_API_URL=http://localhost:3001` (or the real API) set. The
  sql-wasm staging is NOT a manual step — `public/sql-wasm-browser.wasm` is
  copied into dist by expo automatically.
- Browser flow verified: roster → PIN login (Dev Tester) → full download
  (37 synced tables; users 40 / locations 75 / items 149 / stock 73) →
  Users, Roles, Teams, team detail (members + crews), Access (Eddie's
  Locker), Approvals (empty state), Notifications, Activity Log all render.
- **Bidirectional sync round-trip on a Wave B table:** seeded a notification
  row in dev PG → pull picked it up (bell badge 1) → mark-read in UI →
  push landed `read_at` in PG. No console errors.
- Device hotload pass STILL PENDING (S24 Ultra not connected; `adb devices`
  empty) — carried over again, now due at the Wave C checkpoint.
- Web renderer freezes for a few seconds after route pushes (sql.js work on
  the main thread?) — screenshots/CDP time out transiently. Cosmetic-ish;
  keep an eye on it for the Phase 9 web hard pass.

## Wave C progress

### Station C1 — Jobs + job_assignments (2026-09-22)

- `src/repos/jobs.ts` extended from the Wave-A read-only stub to the full
  jobs + job_assignments domain (one file, per the brief's literal scope —
  old app split these into `db/queries/jobs.ts` + `db/queries/
  jobAssignments.ts`, this port keeps them together). New: `upsertJob`
  (dual-writes `type_id` via `resolveTypeId(JOB_CATEGORY, ...)`, same
  precedent as `items.ts`; **omits `job_number` entirely** from the insert —
  the server's BEFORE INSERT trigger assigns it, and including even `null`
  risks an at-least-once-redelivery upsert clobbering an already-assigned
  number), `getAllJobs`, `archiveJob`/`updateJobFields` (both NO self-log —
  caller-owned, matching B1/B2's convention), `getJobDeployments` (derives
  "what's deployed to this job" from `equipment_units.current_job_id` +
  `activity_log` `checkout_to_job` rows joined to count-based items — there
  is NO checkouts table, confirmed no new table/write path was invented),
  `getLatestJobByCustomer`/`getCustomersWithLatestJobDetails` (autofill
  cross-fill support), and the job_assignments trio `getAssignmentsForJob`/
  `getAssignableCrews`/`getMyAssignedJobs`.
  - `assign`/`unassign` (private `assign()` + public `assignJobToCrew`/
    `assignJobToUser`/`unassign`) **deliberately deviate from the no-self-log
    convention** — they self-log inside `runInTransaction`, using raw
    `db.executeSync` + `appendOutbox` instead of a caller-wrapped pattern.
    Documented inline: the idempotency check (re-assigning an already-active
    assignee is a no-op) must run in the same transaction as the insert, and
    the log's `note` needs the resolved assignee display name before it can
    be built. This mirrors old app's own `jobAssignments.ts`, whose
    `jobAssignments.test.ts` documents the "activitylog_uuid trap":
    `activity_log.entity_id` is a UUID column server-side holding the JOB id
    (not the assignment id), with assignee kind/id riding in `metadata` JSON.
    Crew membership resolves at READ time from `team_members.subteam_id`
    (never copied at assignment time); unassign is a soft-delete (`active=0`,
    rows persist for history).
  - `src/repos/jobs.test.ts` (new, 12 tests) — covers upsert/omit-job_number,
    all list/search/detail reads, customer-autofill, field-allowlist updates
    + type_id dual-write, archive (no self-log), deployments derivation,
    crew/user assignment (idempotent re-assign), assignment/crew listing,
    `getMyAssignedJobs` resolving crew membership at read time, and unassign
    (soft-delete + idempotent no-op on an already-inactive row + throws on an
    unknown id).
- `src/components/jobs/JobSummaryCard.tsx` (new) — straight port, no cuts
  (`MapDisplay`/`expo-location` geocoding, dynamic open/closed/archived
  status-badge coloring, all meta rows).
- `src/components/quickadd/JobQuickAdd.tsx` (new) — the OLD app had two
  creation surfaces (`JobQuickAdd.tsx` + a full-page `(jobs)/create.tsx` that
  duplicated ~80% of the same form for an org-authority team picker). This
  wave consolidates on ONE canonical create path (kit rule: grow/reuse, never
  fork a surface) — reused both from the global Quick Add launcher
  (`QuickCreateSheet`'s `'job'` case) and from `jobs/index.tsx`'s "+ New Job"
  FAB (a `ModalSheet`, not a separate route). `create.tsx`'s org-authority
  team picker is dropped without capability loss: `jobs/[id].tsx` still
  offers "Change Team" post-creation for the same tier>=3 audience. Also
  fixes a real bug carried in the old `JobQuickAdd`: its three writes
  (upsert/outbox/log) were NOT wrapped in `runInTransaction` (unlike
  `create.tsx`'s atomic version) — this port wraps them atomically like every
  other Wave B/C quickadd form. Wired into `QuickCreateSheet.tsx`'s `'job'`
  case and `app/(app)/quickadd/[sheet].tsx`'s `'job'` case (both previously
  `return null` / a "coming soon" placeholder); `app/(app)/quickadd/
  index.tsx`'s Job tile un-deferred.
- `app/(app)/jobs/index.tsx` (new plain-dir route) — 'My Checkouts' /'All
  Jobs' tabs (My Checkouts via `getActiveCheckoutsForUser`, unchanged from
  old app — it's checkout-derived, not assignment-derived), search + open/
  closed/all status filter chips + archived toggle, bulk multi-select
  (Close with the #212 close-out guard via `getCloseoutBlockers`/
  `describeCloseoutBlockers`; Archive; Reopen; Set type — all atomic
  transactions with a rollback-on-failure message naming the offending job),
  gated on `create_jobs`/`close_jobs` for actions only (list itself is
  ungated — see hub tile note below). FAB uses `@invenpro/ui`'s `Fab`
  (handles safe-area insets internally) opening `QuickCreateSheet kind="job"`
  and navigating straight into the new job's detail screen on create,
  replacing the old app's separate `create` route push.
- `app/(app)/jobs/[id].tsx` (new plain-dir route) — `JobSummaryCard`, team
  reassignment (org authority tier>=3 only, via `ROLE_TIER`), Assigned Crews
  roster + assign/unassign sheet (`SegmentedControl` crew/individual, gated
  on `create_jobs`), Deployed section (`getJobDeployments`), Activity
  (`getLogForJob` — already existed in mobile-v2's `log.ts`, no porting
  needed), edit form, Request Approval (`RequestApprovalSheet`), Archive.
  Two cuts, both marked inline: Photos (`MediaGallery` doesn't exist in
  mobile-v2 yet) → `TODO(wave-media)`; `DiscussThisButton` chat entry point
  (#228) doesn't exist in mobile-v2 yet → `TODO(wave-chat)`.
- **Hub tile**: no dedicated view/visibility permission exists for jobs in
  the old app (only `create_jobs`/`close_jobs`, both action-specific gates
  the screens apply themselves) — confirmed via `src/auth/permissions.ts`
  and the old app's nav (Jobs had NO tab-bar or dashboard-tile entry at all;
  only reachable via the cut dashboard-preset engine or the checkout job
  picker). Added an UNGATED "Jobs" tile to `app/(app)/index.tsx`'s `TILES`
  array (same tier as My Team/Activity Log — visibility is universal,
  actions gate inside the screens).
- **TODO(wave-C) touchpoint wired**: `checkout.tsx`'s destination job picker
  had a `TODO(wave-C)` for inline job creation (jobs.ts was read-only before
  this station). Added a "+ New Job" affordance via `SearchablePicker`'s
  `onCreate` prop opening `QuickCreateSheet kind="job"`, mirroring `teams/
  [id].tsx`'s inline create-user pattern exactly; `onCreated` calls the
  existing `selectJob()`. Vehicles/repairs/lockers/on-call markers untouched
  (later stations).
- `.expo/types/router.d.ts` regeneration via the pty metro run hit a
  pre-existing environment `ENOSPC` (file-watcher limit) on this machine —
  the process crashed on Node's fs.watch, but not before Metro's file-map
  walk had already regenerated the types file (confirmed by mtime); `/jobs`
  and `/jobs/[id]` route types are present. No manual patch was needed.
- Verified: `pnpm --filter mobile-v2 typecheck` clean; `pnpm --filter
  mobile-v2 test` 112/112 green (was 100/100 after B4, +12 new jobs.test.ts).
  `git status --short apps/mobile` empty throughout.

## Subagent strategy (user decision, 2026-09-22)

Wave A ran 6 parallel screen agents and hit the session rate limit mid-flight.
From Wave B onward: ONE persistent porting agent worked assembly-line style —
coordinator sends it one station (domain) at a time via follow-up messages so
its context/porting patterns carry forward; verify + commit per station before
feeding the next. No parallel fan-out for porting work.

## Unresolved / watch

- expo-notifications absent from dev variant — Wave D notification work must
  test against a release-variant or EAS dev build that includes it.
- Old app untouched and must stay runnable until Phase 10.
- The "VPS" (10.8.0.1) is a QEMU VM `Ubuntu26-InvenPro-VPS` on the Unraid box
  (192.168.1.239) — VM snapshots are an extra rollback lever for Phase 8.
