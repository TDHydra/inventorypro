Preflight reads done: `apps/api/src/lib/schemaShapes.ts` has no vehicles entry (no update needed for #174), and `apps/api/src/db/migrate.ts:38-45` wraps every .sql migration in BEGIN/COMMIT — which forces Eddie's enum `ADD VALUE` and its seed row into two separate migrations (a value added in a transaction cannot be *used* in that same transaction; and if prod PG < 12 it cannot run in a transaction at all — see Wave 4C and Risks).

# InventoryPro Implementation Plan — 12 board items in 6 waves

**Preconditions (all waves)**
- Land/merge branch `gas-receipts` first (it is complete). Each wave = one branch off `main`, ff-merged when done. Never `git add -A` (`.claude/skills/board/*` dirty state is deliberate).
- Mobile checks: `cd apps/mobile && pnpm exec tsc --noEmit && pnpm test` (baseline 593 after gas-receipts). API checks: `cd apps/api && pnpm test` (baseline 417).
- Hotload after each wave via the `start-metro` skill (per CLAUDE.md). API-side changes require `deploy-api`; migrations auto-run on API boot, so every API deploy is a schema ship.
- All UI: `useTheme()`/`useThemedStyles(makeStyles)` only (`src/theme.ts` is a frozen shim — no new imports). Module-scope `makeStyles = (t: Theme) => StyleSheet.create({...})`. No hardcoded hex, emoji icons only, RN core primitives only, no new native modules.
- **expo-image-picker IS installed** (`apps/mobile/package.json:20`, `~56.0.18`) and already used by MediaGallery/QuickPhotoFlow — no fallback needed anywhere in this plan; gallery multi-pick is pure JS config and hotloads.
- Migration number ledger (assign in this order, do not reshuffle): API `067` fuel_level (W2) → `068` role enum (W4) → `069` role seed (W4) → `070` repair_steps (W5). Mobile `055` fuel_level (W2) → `056` repair_steps (W5).

---

## WAVE 1 — Infra + quick wins
**Goal:** `useDbQuery` exists with first real consumers (everything later builds on it); PIN audit closed server-side; odometer graphic shipped. Three tasks, zero shared files.

### Task 1A — #63 useDbQuery hook + first migrations (Idiom-B triples)
**Files:**
- `apps/mobile/src/hooks/useDbQuery.ts` (new) + `apps/mobile/src/hooks/useDbQuery.test.ts` (new)
- `apps/mobile/src/sync/chatPurge.ts` (bug fix while in the area)
- Conversions: `apps/mobile/app/(app)/(jobs)/index.tsx`, `app/(app)/(locations)/[id].tsx`, `app/(app)/(inventory)/[id].tsx`, `app/(app)/(equipment)/[id].tsx`, `app/(app)/(crew)/index.tsx`, `apps/mobile/src/components/ChatBell.tsx`

**Approach:**
- Signature: `useDbQuery<T>(fn: () => T, deps: React.DependencyList, tables?: string[]): T`. Builds on the existing `src/sync/dataVersion.ts` store — no parallel store, no loading/error state (all `src/db/queries/*` are `executeSync`, synchronous).
- ONE `useSyncExternalStore` call whose subscribe/getSnapshot closures branch on `tables` (`subscribeTables`/`getTablesVersion` vs `subscribeDataVersion`/`getDataVersion`), stabilized via `key = tables?.join(',') ?? ''` + `useCallback([key])` — mirrors `useTableVersion` (useDataVersion.ts:18-34) and avoids the conditional-hook trap. Then `return useMemo(fn, [version, ...deps])`. Pass getSnapshot as the third uSES arg (same as existing hooks). Doc-comment: `tables` must be call-site-constant; `fn` may be inline (deps are the cache key).
- Do NOT fold in FlatList referential stability — `useReactiveRows` stays as the list-data hook (its `sameRows` bail is the #91 defense). Leave `useSuggestions` and `useFocusOrDataRefresh` untouched.
- Fix `chatPurge.ts:120`: `bumpDataVersion()` → `bumpTablesVersion(['messages','media'])` (per-table subscribers on the open chat screen currently miss purges).
- Convert the six Idiom-B useState+useEffect triples listed above; delete `(jobs)/index.tsx`'s redundant `reloadKey` machinery. Pass `tables` on each (e.g. `['jobs','checkouts','taxonomy_types']` for jobs index — match what each read touches).
- Tests: node:test mirroring `dataVersion.test.ts`/`useReactiveRows.test.ts` — per-table vs global subscription, dep-change recompute, no recompute on unrelated-table bump.

**Verify:** `tsc --noEmit && pnpm test` (593 + new tests); hotload → open Jobs list, create a job from QuickAdd elsewhere, list updates without pull-to-refresh; open a chat, trigger purge, messages drop.
**Hotloads:** yes.

### Task 1B — #172 PIN-change audit rows (server-authoritative)
**Files:**
- `apps/api/src/routes/me.ts` (change-pin route, :66-127)
- `apps/api/src/routes/users.ts` (`reset_pin` in PATCH :242-254; `POST /users/:id/reset-enrollment-code` :280-338)
- `apps/api/src/lib/syncPolicy.ts` (`ACTIVITY_ACTIONS` set, :408+)
- `apps/mobile/app/(app)/(admin)/users.tsx` (remove client-side `appendLog` at :484, :520, :787)
- API route tests alongside existing ones

**Approach:**
- `POST /me/change-pin` success path: INSERT into `activity_log` copying the exact `auth.ts:437-440` pattern — `gen_random_uuid()`, `action='pin_change'`, `entity_type='user'`, `entity_id=<caller uuid>`, `synced_at NOW()`, `metadata {request_id: request.id}`. Full column list matches sync.ts:355-372. (`/auth/set-pin` already logs `pin_set`; `/auth/token` logs `login` — do not touch.)
- Admin reset routes: same INSERT with `action='user_pin_reset'`, `entity_id=<target uuid>`, `created_by=<caller>`, target name in `note` (UUID-only refs per `lib/activityLog.ts` rules).
- Add `'pin_change'` to `ACTIVITY_ACTIONS` (defensive — server-only today, but keeps the allowlist truthful if a client ever pushes it). `'user_pin_reset'` is already present.
- Remove the three device-dependent `appendLog` calls in mobile `users.tsx` so admin resets don't double-log once the server is authoritative.
- No schema change → SYNC-MIGRATION-CHECKLIST not triggered. Rows sync down via normal activity_log pull.

**Verify:** API suite green (417 + new); manual: change PIN on device → `SELECT * FROM activity_log WHERE action='pin_change'` on the API DB; admin reset → single `user_pin_reset` row, not two.
**Hotloads:** mobile part yes; server part needs `deploy-api` (no migration).

### Task 1C — #175 odometer graphic (UI-only)
**Files:**
- `apps/mobile/src/components/ui/OdometerRoll.tsx` (new kit component — the wave's one new generic component, VerticalLevelSlider precedent)
- `apps/mobile/src/components/vehicles/VehicleHistoryPanel.tsx` (the component being extended — its existing "Miles" Card at :70-90)

**Approach:**
- `OdometerRoll` props: `{ value: number; digits?: number }`. Per digit: fixed-height cell (`overflow: 'hidden'`), vertical strip of Text glyphs 0-9 plus a duplicate "0" at index 10; `Animated.timing` on `transform: translateY` with `useNativeDriver: true` (JS fallback on web is automatic); 9→0 rollover animates to index 10 then `setValue(0)` on completion; stagger columns with `Animated.parallel` + delay. RN core `Animated` only — reanimated is not installed and must not be added.
- Tokens: cell bg `t.colors.surfaceAlt`, digit color `t.colors.textStrong`, separator `t.colors.border`, radius `t.radii.sm`, size `t.typography.fontSizes.lg` with `t.typography.fontFamily.mono`, duration `t.motion.duration.base`, respect `t.motion.enabled` (snap instantly when false).
- In `VehicleHistoryPanel`, render `<OdometerRoll value={latestReading.odometer} />` as the Miles card header (latest row from existing `getOdometerTimeline`); keep the existing delta rows (`odometerDeltas`) unchanged below. No new queries, no schema.
- Doc-comment usage notes in the component file, not the README (kit convention).

**Verify:** `tsc && pnpm test`; hotload → vehicle history panel shows rolled digits; add a service record with a higher odometer → digits roll up; switch to Futuristic (dark) theme → contrast holds.
**Hotloads:** yes.

---

## WAVE 2 — Vehicles wave 3: fuel gauge + server guard
**Goal:** `vehicles.fuel_level` end-to-end (#174) and the vehicles lock/share columns server-guarded (#176). Disjoint file sets (2A: syncPolicy.ts col list, pull.ts, queries, panel; 2B: sync.ts + new lib). **Deploy lockstep:** deploy API (applies 067) before or with the mobile hotload.

### Task 2A — #174 vehicle fuel gauge (schema: vehicles.fuel_level)
**Files (full sync-migration checklist for `vehicles`):**
- `apps/api/src/db/migrations/067_vehicle_fuel_level.sql` (new): `ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS fuel_level INTEGER NOT NULL DEFAULT 0;` — 065 template; INTEGER not enum; no backfill, no `updated_at` bump (avoids re-download storm)
- `apps/api/src/lib/syncPolicy.ts:488` — append `fuel_level` to `VEHICLES_COLS` (used by `selectColumnsFor` :515; grep sync.ts for any other vehicles column list — schemaShapes.ts confirmed clean)
- `apps/mobile/src/db/migrations/055_vehicle_fuel_level.ts` (new, `version: 55`, 053 template) + sibling `.test.ts`; register in BOTH `src/db/schema.ts` `loadMigrations()` (~:87) and `src/db/schema.web.ts` dynamic list (~:164)
- `apps/mobile/src/sync/pull.ts` — `TABLE_UPSERT_SQL.vehicles` (:32, add col + placeholder, keep parity) AND `rowToValues` case `'vehicles'` (:68)
- `apps/mobile/src/db/queries/vehicles.ts` — `VehicleRow` (:37-53), `VehicleStatePatch` (:98-109), `upsertVehicleState` merge/INSERT/params (:117-166)
- `apps/mobile/src/components/vehicles/vehicleSessionLogic.ts` (+ its node:test) — `snapFuelLevel` next to `snapDebrisLevel` (:201-204): round to 10s, clamp 0-100
- `apps/mobile/src/components/vehicles/VehiclePanel.tsx` — gauge UI

**Approach:**
- UI mirrors the debris precedent exactly: in the state card, `FieldLabel "Fuel"` + reuse **`VerticalLevelSlider`** as-is (`value={vehicle?.fuel_level ?? 0}`, `onCommit={raw => upsertVehicleState(locationId, { fuel_level: snapFuelLevel(raw) }, user?.id ?? null)}`); maintenance-locked renders plain `<Text>` percent (VehiclePanel.tsx:355-370 pattern). Do NOT fork the slider.
- UNGATED by any option flag (every vehicle has fuel — unlike `debris_option`) and deliberately permission-less like all vehicle state writes (VehiclePanel.tsx:281-287 comment; server `vehicles: {INSERT/UPDATE: null}` until 2B, which does not protect `fuel_level`).
- Fuel pill in the `statusPills` row (:216-258): `StatusPill label={fuel_level + '% fuel'} tone={fuel_level <= 20 ? 'warning' : 'neutral'}` — inverted twin of the debris `>= 80` warning; tones resolve to `t.colors.warningBg/warningText` / neutral pair, no new tokens.
- Do NOT auto-set `fuel_level=100` on fuel_up receipts — partial fills make it wrong; recorded as a deferred design question (see Risks).
- Migration test mirrors `053_vehicle_options.test.ts`.

**Verify:** mobile `tsc && pnpm test`; API suite (pullColumns parity test enforces col counts); deploy-api → 067 applies; hotload → drag fuel slider, kill/reopen app (persisted), second device pulls the value; ≤20% shows warning pill.
**Hotloads:** mobile yes; requires API deploy in lockstep for cross-device sync.

### Task 2B — #176 server-side vehicles lock/share guard
**Files:**
- `apps/api/src/lib/vehicleLockPolicy.ts` (new pure policy fn) + `vehicleLockPolicy.test.ts` (new)
- `apps/api/src/routes/sync.ts` — guard block inside the push entry loop (`for (const entry of entries)` :863), modeled byte-for-byte on the `unit_access` guard at :1478-1514
- Uses existing `ROLE_TIER`/`effectiveTier` from `apps/api/src/lib/permissions.ts:19,40`

**Approach (the unit_access pattern, value-change keyed):**
- Protected columns: `checkout_locked`, `open_checkout`, `locked_by`. Guard BOTH INSERT and UPDATE on `vehicles` (the generic INSERT is an upsert — sync.ts:1092 comment).
- **Critical trap:** mobile `upsertVehicleState` pushes the FULL merged row, so every crew tank/fuel write carries the protected columns unchanged. The guard must fetch the current DB row and enforce ONLY when a protected column's VALUE actually changes; non-changing protected values pass through untouched. A payload-contains-column guard would block every crew write.
- All facts from the DB in one query, never the payload: current vehicle row, `l.owner_user_id`, caller role/tier, `EXISTS` shares-team-with-owner join, locked-by user's tier. Missing location row fails closed with permanent wording (matches the mobile engine's drop regex — copy the unit_access wording style).
- Pure fn `canChangeVehicleLock({callerId, callerTier, ownerUserId, sharesTeamWithOwner, currentLockedBy, lockedByTier})` mirroring mobile `canManageVehicle` (access.ts:342-351: owner OR tier>=3 OR (tier>=2 AND shares team)) AND `canLiftVehicleLock` (vehicleSessionLogic.ts:187-198: manage && (lockedBy null || self || callerTier >= lockerTier)) — node-tested against the mobile truth table.
- `locked_by` is server-stamped: when `checkout_locked` transitions 0→1 the server overwrites payload `locked_by` with the caller's id (it is not in `ATTRIBUTION_COLUMNS` and is otherwise forgeable); on 1→0 require `canLiftVehicleLock`; a `locked_by` change without a lock transition is stripped back to the DB value.
- On rejection: `request.log.warn(...)` + `conflicts.push({id: entry.id, error: 'Forbidden: ...'})` + `continue` — never throw.
- Add sync integration cases to the existing API suite: crew fuel/tank write carrying unchanged lock cols passes; crew flipping `checkout_locked` rejected; lower-tier lifting higher-tier lock rejected; owner lift passes.

**Verify:** API `pnpm test` (417 + new); on-device after deploy: crew account drags fuel slider (2A) → syncs clean; crew toggling lock in VehicleEditSheet → sync conflict logged, state reverts on next pull.
**Hotloads:** no — API only (`deploy-api`, no migration of its own).

---

## WAVE 3 — Permission-aware UI + resolution reconcile (+ #63 bug-fix conversions)
**Goal:** #76 fully closed: client gates match server enforcement, denied controls can explain themselves, and client/server resolution can no longer disagree. Plus the missing-reactivity fixes from the #63 migration list (net bug fixes, disjoint files).

### Task 3A — #76 client: disable-with-reason mode + gate coverage
**Files:**
- `apps/mobile/src/components/PermissionGate.tsx` (the component being extended)
- `apps/mobile/src/constants/roles.ts` (hoist/ensure a `PERMISSION_LABELS: Record<Permission,string>` — reuse the display-label map `app/(app)/(admin)/roles.tsx` already renders; if it is local to roles.tsx, hoist it here and re-import there)
- Gate fixes: `apps/mobile/src/components/quickadd/JobQuickAdd.tsx`, `src/components/quickadd/TeamQuickAdd.tsx`, `src/components/quickadd/VehicleQuickAdd.tsx`, `src/components/CsvImport.tsx`, `app/(app)/(admin)/dashboards.tsx`, `app/(app)/(admin)/manage-types.tsx`, `app/(app)/(locations)/[id].tsx`

**Approach:**
- Extend `PermissionGate` with `mode?: 'hide' | 'disable'` (default `'hide'`, fully backward compatible). In `'disable'` when denied: render children inside a `View pointerEvents="none"` at reduced emphasis plus a one-line reason `<Text>` — `"Requires " + PERMISSION_LABELS[permission]`. Tokens: reason text `t.colors.textMuted` at `t.typography.fontSizes.caption12`; dimmed content via `t.colors.textDisabled`-driven opacity. This generalizes the `{editable, reason}` shape `canEditRolePermission` already uses in roles.tsx:387-394 — same UX, one component.
- Gate-coverage fixes (each mirrors the server requirement, using `mode="disable"` on the save/submit control so users learn why instead of hitting a sync conflict):
  - `JobQuickAdd` save → `create_jobs` (server: syncPolicy.ts:331)
  - `TeamQuickAdd` save → `manage_teams` (server: PRIVILEGED_TABLE_PERM)
  - `VehicleQuickAdd`'s `upsertLocation` path → `manage_locations` (server: locations INSERT)
  - `CsvImport` import button → `add_inventory` (server: add/edit_inventory)
  - `dashboards.tsx:138` — replace `isTier4` with `usePermission('system_settings')` (server gates `dashboard_presets` on system_settings; overrides now move the client gate)
  - `manage-types.tsx:331` — replace `isTier4` with `usePermission('edit_inventory')` (server gates taxonomy on add/edit_inventory)
  - `(locations)/[id].tsx:478` Move Stock → `edit_inventory` (server enforces edit_inventory via `stock_by_location`, not manage_locations)
- Leave documented-intentional sites alone: teams roster tier gate ((teams)/[id].tsx:86-96), vehicles state (crew-level by design), lockers/units/chat (server row-level).
- Do NOT gate `AddServiceRecordSheet` fuel-ups — 3B fixes that server-side instead (mobile behavior is the #168 design).

**Verify:** `tsc && pnpm test`; hotload as a `mitigation_technician` with `quick_add`: Job quick-add save is disabled with "Requires Create jobs"; grant `create_jobs` via role editor → control enables live (reactive perm store); office_manager granted `system_settings` now sees dashboards admin.
**Hotloads:** yes.

### Task 3B — #76 server: resolution reconcile
**Files:**
- `apps/api/src/lib/permissions.ts` (team-override layer, ROLE_DEFAULTS parity) + its tests
- `apps/api/src/routes/sync.ts` (fuel_up carve-out near the operation-perm check, :849-850 area)
- `apps/api/src/lib/syncPolicy.ts` only if the carve-out fits better beside `requiredOperationPerm` (:331,:375)

**Approach:**
- **Team-override layer (the #76 root cause):** server has no team context per push entry, so full parity is impossible; implement the documented union rule — in `userHasPermission`, for perms in `TEAM_OVERRIDABLE_PERMISSIONS` (syncPolicy.ts:97), read `team_permission_overrides` for ALL teams the caller belongs to and apply **positive grants only** (union). Client already applies the team-scoped version for UI; server union means anything a client could legitimately show is accepted, and denials never widen server access. Document the asymmetry in a comment.
- Add `quick_add` to every API `ROLE_DEFAULTS` map (permissions.ts:144-264) mirroring mobile `constants/roles.ts` tier maps exactly — closes the silent drift before any server op ever gates on it.
- Add explicit `edit_media: false, delete_media: false` to API tempEmployee (:259-264) for byte-parity with mobile roles.ts:261-268.
- **fuel_up carve-out (live regression on gas-receipts):** `vehicle_service_records` INSERT currently requires `edit_inventory`, but #168 deliberately lets non-editors file fuel-ups (AddServiceRecordSheet.tsx:81-83). Before the operation-perm rejection, allow INSERT when the payload's `kind === 'fuel_up'` (validate kind against the known set; all other kinds keep requiring edit_inventory). Add a test: crew fuel_up passes, crew oil-change rejected.
- Add a parity node:test that walks mobile-vs-API ROLE_DEFAULTS shapes if a shared fixture is feasible; otherwise assert the specific keys fixed here.
- `transfer_between_locations` stays unenforced server-side — out of scope; noted in Risks as a follow-up board item.

**Verify:** API `pnpm test`; end-to-end: team-override-granted `create_jobs` tech creates a job → push accepted; crew files a gas receipt → accepted (was rejected).
**Hotloads:** no — API only (`deploy-api`).

### Task 3C — #63 migration: missing-reactivity bug fixes
**Files:** `apps/mobile/src/components/quickadd/LocationQuickAdd.tsx`, `src/components/vehicles/VehicleCheckoutSheet.tsx`, `src/components/oncall/CoverageSheet.tsx`, `src/components/vehicles/AddServiceRecordSheet.tsx`, `src/components/quickadd/EquipmentQuickAdd.tsx`, `src/components/pickers/ItemPicker.tsx`, `src/components/QrSigningSection.tsx`

**Approach:**
- Convert each frozen-after-sync read to `useDbQuery(fn, deps, tables)`: LocationQuickAdd `getTopLevelLocations` → `['locations']` (delete its private refreshKey); VehicleCheckoutSheet `getOpenJobs` → `['jobs']`; CoverageSheet `getAllActiveUsers` → `['users']`; AddServiceRecordSheet option loads → `['locations','jobs','teams']`; EquipmentQuickAdd/ItemPicker search memos add the tables key alongside the search-text dep (`['inventory_items','equipment_units']`); QrSigningSection replaces its hand-rolled version counter.
- No behavior changes beyond data now refreshing on sync; keep every existing dep.
- These are net bug fixes (synced rows currently never appear while mounted).

**Verify:** `tsc && pnpm test`; hotload: open Location quick-add on device A, create a location on device B, sync → it appears without remount.
**Hotloads:** yes.

---

## WAVE 4 — Hub flows + Eddie role
**Goal:** equipment returns from the hub (#151), GPS-default destinations (#179), and the duct-cleaning role live end-to-end. Three disjoint file sets.

### Task 4A — #151 hub equipment returns (v1 slice: Fast Check-In flow)
**Files:** `apps/mobile/app/(app)/(hub)/index.tsx` (only file — extends the existing batch bar/panel in place)

**Approach:**
- **Slice decision:** returns live in the Fast Check-In flow (`?dir=in`, #83). Replace the equipment refusal at :237-246: in `flowDir==='in'`, an `equipment-unit` scan with `unit.status==='deployed'` enqueues into a `returnBatch` (same shape as `equipBatch`, capture `current_job_id` per unit NOW — `classifyScan` already returns status/current_job_id/current_location_id, no query changes). Non-deployed unit in an in-flow → alert "`<tag>` isn't checked out." In the `'out'` flow, keep the existing "not available" alert for deployed units but append "Use Fast Check-In to return it." (bidirectional smart-scan stays a separate backlog item).
- **Policy decision (documented in-code):** hub returns accept ANY deployed unit, not just the scanner's own (supervisor tool; the checkin screen keeps its own-units restriction). Keep the exact log shape — `action:'checkin'`, `quantity:1`, `note:'unit '+asset_tag`, `job_id` = captured `current_job_id` — so `getDeployedUnitsForUser`'s note-based inference (equipmentUnits.ts:80-101) stays intact.
- Batch bar: reuse the existing panel (:638-664) — heading "N units to return", rows `"↩ {asset_tag} · {item_name}"` with the per-row ✕; the panel keeps its documented camera-overlay hardcoded-rgba exception (:985-996). "Done scanning →" → destination mode.
- Destination: reuse the existing destination ModalSheet + `DestinationPicker`, but when committing a return batch only Location destinations are valid — reject job/manager/office resolutions with an alert (v1; no new DestinationPicker props needed since validation happens in `onDestResolved`).
- `commitReturnBatch(dest)` mirrors `commitEquipmentBatch` (:531-608) and the checkin unit loop ((checkin)/index.tsx:271-364): #162 foreign-unit guard on dest, then one `runInTransaction` — per unit `setUnitStatus(u.id, {status:'available', current_location_id: dest.toLocationId, current_job_id: null})` + `outboxUnit` (:209-217, `synced_at` omitted) + `appendLog` per above with GPS coords; stable event UUID on the first log row; aggregate ScanReceipt entry + `askAnythingElse()`; failure → alert, clear batch, back to scanning.
- No schema, no server change (equipment_units writes already authorized).

**Verify:** `tsc && pnpm test`; hotload: dashboard Fast Check-In → scan two deployed unit tags → both queued → done → pick location → units show available at that location, activity log shows two `checkin` rows with job attribution; equipment screen agrees.
**Hotloads:** yes.

### Task 4B — #179 GPS-default destination
**Files:**
- `apps/mobile/app/(app)/(checkout)/index.tsx` (destination step, :771-777)
- `apps/mobile/src/components/hub/DestinationPicker.tsx` (Location branch, :254-265)
- Reuses `src/components/LocationSuggestionBanner.tsx` and `sortByProximity` (`src/location/proximity.ts`) unchanged

**Approach:**
- Checkout destination step: add `proximitySort` to the existing `LocationShelfPicker` (prop already exists) and render `LocationSuggestionBanner` above it — derive `nearestDest` exactly like checkin's precedent ((checkin)/index.tsx:100-111): `sortByProximity(getAllLocations().filter(...), coords)` first non-null `distanceM`, additionally filtered by the step's `excludeIds=[source]`. "Use it" sets the destination location value; **never auto-commit** (banner contract).
- `DestinationPicker` Location branch: same banner above its `LocationShelfPicker` (which already has `proximitySort`); on "Use it", route through the existing selection path so shelf-deferral/`resolveLocationShelfSelection` semantics (:96-108) are untouched. Note: in DestinationPicker, selecting a location IS the commit — the banner's "Use it" is therefore an explicit tap, which satisfies never-auto-commit.
- GPS acquisition: reuse the screens' existing `useCurrentPosition` fire-and-forget on mount; no new expo-location calls needed (hub already requests at :154; checkout already has coords for its source banner at :140-166). Graceful degrade: null coords → banner renders nothing, sort falls back to original order (both built-in).
- No new tokens/components — banner and picker are the reuse targets.

**Verify:** `tsc && pnpm test`; hotload outdoors/with location on: checkout → destination step shows "You're at X (~N m)" and nearest-first ordering; deny location permission → identical to today.
**Hotloads:** yes.

### Task 4C — Eddie duct-cleaning role
**Files:**
- `apps/api/src/db/migrations/068_add_role_duct_cleaning.sql` (new): ONLY `ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'duct_cleaning_technician';`
- `apps/api/src/db/migrations/069_seed_role_duct_cleaning.sql` (new): `role_settings` seed row (min_pin_length per tier-1 pattern, 001:36-49 template) — **must be a separate file**: migrate.ts:38-45 wraps each file in one transaction, and a same-transaction use of a new enum value fails
- `apps/api/src/lib/permissions.ts` — `ROLE_TIER` (:19-33, tier 1) + `ROLE_DEFAULTS` (:266-280, tier-1 defaults incl. the `quick_add` value added in 3B)
- `apps/api/src/db/seeds/seed.sql` (:16,:33) + `seed.ts`
- `apps/mobile/src/constants/roles.ts` — `UserRole` union (:1-14), `ROLE_TIER` (:47-61), `ROLE_DISPLAY_NAMES` "Duct Cleaning Tech" (:91-105), `ROLE_COLORS` from `ROLE_COLOR_PALETTE` (:120-134), `ROLE_DEFAULTS` (:270-284)
- `apps/mobile/src/dashboard/roleLayouts.ts` — `ROLE_DEFAULT_LAYOUTS['duct_cleaning_technician'] = CREW_LAYOUT` (:104-148)

**Approach:**
- Role id `duct_cleaning_technician`, tier 1 (crew), no permission deviations in v1; PIN length falls out of `PIN_LENGTH_BY_TIER`; dashboard = `CREW_LAYOUT` (Wave 5A may swap in a duct variant; keep this line additive so there is no file conflict).
- **Preflight:** `SELECT version()` on prod PG. PG ≥ 12: ADD VALUE inside the runner's transaction is fine (value is unused until 069). PG < 12: add a `-- @no-transaction` marker convention to `migrate.ts` (skip BEGIN/COMMIT for marked files, keep the schema_migrations insert) and mark 068 — small, tested change.
- Never a PG enum for anything NEW — this is the one sanctioned enum touch (extending the existing `user_role` type).
- No mobile migration (local role column is TEXT) and no sync-checklist work (no new columns; the 069 seed row pulls via existing `ROLE_SETTINGS_COLS`). Role pickers auto-include via `ALL_ROLES = Object.keys(ROLE_DISPLAY_NAMES)` (users.tsx:51); unknown-role fail-closed paths protect old app builds.
- Optionally mirror the 045 demo-account convention with an Eddie test account (skippable).
- Order within the deploy: API deploy (068+069 auto-apply) → mobile hotload → create/convert Eddie's user.

**Verify:** API + mobile suites; deploy-api → boot log shows 068, 069 applied; hotload → admin Users role picker lists "Duct Cleaning Tech"; assign it → Eddie's dashboard renders CREW_LAYOUT, PIN rules tier-1, role color renders in logs/chat.
**Hotloads:** mobile yes; requires API deploy first (enum must exist before a device pushes a user row with it).

---

## WAVE 5 — Dashboard presets + repairs v1 slice
**Goal:** daily-driver dashboards (#177) and the buildable v1 of the repair-troubleshooting epic (#178): steps log + status trail. Disjoint files.

### Task 5A — #177 daily-driver dashboard presets
**Files:**
- `apps/mobile/src/dashboard/widgets.ts` (`StatSource`/`WorkListSource` unions :34-49, `WIDGET_REGISTRY` if needed)
- `apps/mobile/src/components/dashboard/StatTiles.tsx` (`STAT_DEFS` :36-68) and `src/components/dashboard/WorkList.tsx` (`WORK_LIST_DEFS` :54-119)
- `apps/mobile/src/dashboard/roleLayouts.ts` (CREW_LAYOUT :23-38, TIER2_MANAGER_LAYOUT :43-58, the new duct role line from 4C)
- `apps/mobile/app/(app)/(admin)/dashboards.tsx` (editor display names for new sources)

**Approach:**
- New sources (extend the data-driven records — the sanctioned extension point; runtime-validated `isStatSource`/`isWorkListSource` keeps old persisted presets safe):
  - `StatSource 'vehicles-available'` — count of vehicle locations passing `isVehicleAvailableForCheckout` (queries/vehicles.ts:394-414; per-row query is sanctioned for small vehicle lists per wave1 plan Task 8), icon 🚐, route `(vehicles)`, no requiredPermission (vehicle state is crew-level).
  - `WorkListSource 'vehicles'` — vehicle rows with availability via the same helper, `rowRoute` → `(vehicles)/[id]`.
- Preset design pass (the "daily driver"): CREW_LAYOUT gets stat-tiles `[my-checkouts, vehicles-available]`, work-lists `my-jobs` + `my-equipment`, quick-actions block, on-call — a start-shift/end-shift reading order; TIER2 adds `open-repairs` + `low-stock`. ADMIN_LAYOUT untouched (the "got rid of all my buttons" review). These are STARTERS per the file's own comment — the wave's hotload session IS the on-device review; expect one-line config tweaks with the user before merge (the epic's brainstorm-first directive is satisfied by reviewing live defaults together, not by building more).
- Duct role: point `duct_cleaning_technician` at CREW_LAYOUT still, unless the review says otherwise.
- Everything is config + registry entries — `PermissionGate` wrapping, `useReactiveRows`, and defensive config parsing come free from StatTiles/WorkList. No schema (presets table already synced).

**Verify:** `tsc && pnpm test`; hotload per role (admin preset switcher / test accounts): crew sees the new layout, vehicles tile count matches the vehicles list "Available" segment, old custom presets still render (unknown-source tolerance).
**Hotloads:** yes.

### Task 5B — #178 repair troubleshooting v1: steps log + status trail (epic sliced)
**Epic decomposition:** v1 (this task) = immutable troubleshooting-steps log + status trail on the repair detail. **Deferred to later phases (file as board items):** P2 prior-fault history panel (query `getRepairsForEntity` already exists — UI only), P3 parts-per-step (`repair_parts.step_id` column — own sync-checklist migration), P4 guided workflows/templates.

**Files (full sync-migration checklist for the NEW synced table `repair_steps`):**
- `apps/api/src/db/migrations/070_repair_steps.sql` (new): `repair_steps(id TEXT PK, repair_id TEXT, action TEXT NOT NULL, result TEXT, created_by TEXT, created_at, updated_at, synced_at)` — no FKs (sync-order safety, repair_parts precedent), index on repair_id
- `apps/mobile/src/db/migrations/056_repair_steps.ts` (new, `version: 56`) + `.test.ts`; register in `src/db/schema.ts` AND `src/db/schema.web.ts`
- `apps/mobile/src/sync/pull.ts` — add `repair_steps` to `TABLE_UPSERT_SQL` + `rowToValues`
- `apps/api/src/routes/sync.ts` — ALLOWED_TABLES/FULL_TABLES + `apps/api/src/lib/syncPolicy.ts` — cols list + operation perms: INSERT → `edit_inventory` (matches repairs), UPDATE/DELETE forbidden (immutable log)
- `apps/mobile/src/sync/fullDownload.ts` — SYNC_TABLES (after repairs; the migration-033 header documents this full wiring pattern)
- `apps/mobile/src/db/queries/repairs.ts` — `addRepairStep(repairId, action, result)` (local INSERT + `appendOutbox('INSERT','repair_steps',…)`, repair_parts :171 template), `getRepairSteps(repairId)`
- `apps/mobile/app/(app)/(repairs)/[id].tsx` — UI

**Approach:**
- **Steps log UI** on repair detail: a "Troubleshooting" `Card variant="detail"` listing steps chronologically (`KeyValueRow`-style rows: action text, result line, author + relative time in `t.colors.textMuted` at `t.typography.fontSizes.caption12`); "Log a step" opens **`EntityEditSheet`** (the extend target — it owns persistence; throw to stay open) with `TextField "What did you try?"` (required, multiline) + `TextField "Result"`; gated `edit_inventory` via `PermissionGate mode="disable"` (from 3A). Reactive via `useDbQuery(() => getRepairSteps(id), [id], ['repair_steps'])`.
- Each saved step also `appendLog({action:'repair_status_changed'…})`? No — steps are their own record; append a plain activity_log row `action:'repair_step_added'` ONLY if desired later; v1 skips it (ActivityFeed already shows status churn; avoid allowlist churn).
- **Status trail** (no schema): horizontal `StatusPill` row above the FilterChip status picker — statuses from `getRepairStatusesWithFallback()` ordered by `sort_order`, rendered as: past/visited (from this repair's activity_log `repair_status_changed`/`repair_completed` entries, already queryable via the existing log read) → `tone='success'` (`t.colors.successBg/successText`), current → `tone='primary'`, not-yet → `neutral`; wrap in a horizontal ScrollView, `t.spacing.sm` gaps. Pure derivation helper `buildStatusTrail(statusesInOrder, logRows, currentStatusId)` as a node-tested sibling (vehicleSessionLogic pattern). No taxonomy reseeding in v1 — the existing Open→Awaiting Parts→In Progress→Repaired/Cannot Repair set with `meta.terminal` is the trail.
- Deploy lockstep: API 070 first, then mobile hotload (a device pushing `repair_steps` before the table exists would 500/conflict).

**Verify:** mobile + API suites (incl. pullColumns parity + migration test); deploy-api → 070; hotload: log two steps on a ticket → visible on second device after sync; change status → trail pills update; UPDATE attempt on a step via crafted outbox is rejected server-side (API test).
**Hotloads:** mobile yes; API deploy required first.

---

## WAVE 6 — Gallery media share + #63 sweep
**Goal:** #171 complete (gallery add + audience picker + push + email stub) and the useDbQuery migration finished.

### Task 6A — #171 mobile: gallery pick + share entry point
**Files:**
- `apps/mobile/src/components/quickphoto/QuickPhotoFlow.tsx` + `src/components/quickphoto/quickPhotoLogic.ts` (+ its node:test) — the components being extended
- `apps/mobile/app/(app)/(media)/index.tsx` — add the entry point (screen has no + button today)
- Reuses `ui/Fab.tsx` as-is

**Approach:**
- **expo-image-picker is installed** (`~56.0.18`) — no fallback path needed; this is pure JS and hotloads.
- Extend `quickPhotoLogic.ts`'s state machine with a `source: 'camera' | 'gallery'` alongside the existing phases (pure, node-tested); destination/audience phase is **reused unchanged** — the existing job-picker / "My team" / "Everyone" / "Specific users" sheet (:189-237) IS the audience picker, and `buildUploadInput` already maps `QuickPhotoDest` → `audience`/`audienceUserIds` (uploadCore.ts:27-40).
- Gallery branch beside `runCamera()` (:105): `launchImageLibraryAsync({ mediaTypes: ['images','videos'], allowsMultipleSelection: true, selectionLimit: 10, quality: 0.85 })`. SDK 56 gotchas baked in: do NOT pass `allowsEditing` (ignored + warns with multi-select); branch on `result.canceled` (`assets` is `null`, not `[]`, on cancel); string-array `mediaTypes` (enum removed); library launch needs no permission prompt on modern Android/iOS Photo Picker. Feed each asset through the existing details phase → sequential `runUploadQueue` semantics (25 MB per-file cap already enforced in uploadCore).
- Media hub screen: `Fab` (`{onPress, label:'＋', accessibilityLabel:'Share media'}` — theme-shaped via `t.components.fab`, safe-area handled) opening a two-option `ModalSheet` ("Take photo" → `openQuickPhoto()` as-is; "Choose from gallery" → `openQuickPhoto({ source: 'gallery' })` — add that options param to the exported opener).
- Push notify: **already shipped** (#87) — pool INSERT triggers the sync.ts:1597-1633 fire-and-forget → `resolvePoolRecipients` → `deliver()` inbox rows + Expo push. Verification-only here; no mobile notification code.
- While in the file, convert `(media)/index.tsx:118`'s version read to `useDbQuery` (Task 6C skips this file).

**Verify:** `tsc && pnpm test` (+ quickPhotoLogic tests); hotload: media hub → Fab → gallery → multi-select 3 → audience "Specific users" → recipients get push + inbox row and see the items under Shared; cancel picker → clean return, no crash (null-assets branch).
**Hotloads:** yes.

### Task 6B — #171 email leg: provider-agnostic stub only
**Files:**
- `apps/api/src/lib/shareEmail.ts` (new) + `shareEmail.test.ts` (new)
- `apps/api/src/routes/sync.ts` (media-share hook, :1597-1633)
- Reuses `apps/api/src/lib/mail.ts` — **a provider-agnostic mailer already exists** (nodemailer/SMTP-env `sendMail`, degrades with `{sent:false, reason:'smtp-not-configured'}`, never throws); "no real provider" = simply never configuring SMTP env

**Approach:**
- Define the stub interface: `interface ShareEmailSender { sendMediaShareEmail(input: { to: string; senderName: string; note: string | null; mediaId: string }): Promise<{ sent: boolean; reason?: string }> }`; default implementation delegates to `sendMail({ to, subject, text, category: 'Notification' })` with a deep-link line — no new dependency, no provider decision.
- Wire into the existing share hook after `deliver()`: behind env flag `MEDIA_SHARE_EMAIL=1` (default OFF — stub-only per the board item), fire-and-forget; recipients from the same `resolvePoolRecipients` list, emails via `users.email` (038 column), skip null emails; `'everyone'` audience never emails (mirrors its quiet-push rule).
- Injectable sender for tests (the `me.ts:51-56` injected-`sendCode` seam pattern); tests cover: flag off → nothing; flag on + no SMTP → graceful `smtp-not-configured`; injected sender receives correct recipients.
- No schema, no allowlist changes.

**Verify:** API `pnpm test`; deploy is optional this wave (dormant behind the flag).
**Hotloads:** no — API only.

### Task 6C — #63 finish: mechanical Idiom-A sweep
**Files:** the remaining `useMemo(() => query(), [version,...])` sites from the consumer census — order: `app/(app)/(chat)/[id].tsx` (delete its private reloadKey) and detail screens first (`(inventory)/[id].tsx` remainder, `(jobs)/[id].tsx`, `(teams)/[id].tsx`, `(repairs)/[id].tsx`, `(equipment)/index.tsx`, `(checkout)/index.tsx`, `(checkin)/index.tsx`, `(dashboard)/index.tsx`, pickers, quickadds), admin screens last (`users.tsx`, `roles.tsx`, `settings.tsx`, `broadcast.tsx`, `dashboards.tsx`, `manage-types.tsx`, `on-call-settings.tsx`, `label-templates.tsx`). SKIP: `(media)/index.tsx` (done in 6A), anything using `useReactiveRows`/`useSuggestions`/`useFocusOrDataRefresh` (specialized contracts stay).

**Approach:**
- Pure mechanical conversion to `useDbQuery(fn, deps, tables)`, adding per-table granularity as each site converts (~20 sites move off the global counter → fewer wasted re-queries per pull).
- One site per commit-group per screen; no behavior changes; keep every existing dep; `tables` chosen from what each query actually reads.
- Where a screen composes `useFocusOrDataRefresh`, leave that hook driving the key and do not double-subscribe.
- After the sweep, file a follow-up board item to consider re-implementing `useReactiveRows` atop `useDbQuery` + compare option — do not do it now (#91 defense).

**Verify:** `tsc && pnpm test`; hotload smoke across the five main tabs + one admin screen; scroll a long inventory list during a background sync — no jump/freeze (ref-stability regression check, #91 class).
**Hotloads:** yes.

---

## RISKS

1. **Deploy lockstep (W2, W4, W5):** API migrations auto-run on boot. Order is always API-deploy-then-hotload; a device on new mobile code pushing `fuel_level`/`repair_steps`/the new role before the API has 067/070/068 will conflict or silently drop. Conversely old APKs receiving new columns are safe (hardcoded column lists ignore extras).
2. **#176 full-row upsert trap:** mobile pushes the entire merged vehicles row, so a naive guard bricks every crew tank/fuel write. Mitigated by value-change keying + the "crew write carrying unchanged lock cols passes" test — that test is non-negotiable.
3. **Enum migration (W4C):** `ALTER TYPE ... ADD VALUE` semantics depend on prod PG version; verify `SELECT version()` before writing 068. Two-file split is mandatory regardless (migrate.ts one-transaction-per-file). If PG < 12, the `-- @no-transaction` runner change adds scope.
4. **#76 server team-override union loosens scoping:** server accepts a team-overridable grant from ANY of the caller's teams (client remains team-scoped). Grants-only application caps the blast radius, but document it; `transfer_between_locations` remains unenforced server-side — file a follow-up board item.
5. **#63 sweep regressions (#91 class):** converting list-feeding memos can reintroduce mid-scroll ref churn. `useReactiveRows` consumers are excluded, but the W6C manual scroll-during-sync check must actually be performed.
6. **#151 policy widening:** hub returns accept any deployed unit (vs checkin's own-units). If field misuse appears, the fix is a one-line filter to own+tier2 — but the log-shape contract (`note='unit '+asset_tag`) must never change or `getDeployedUnitsForUser` breaks.
7. **#174 open design question:** no auto-set of `fuel_level` on fuel_up receipts (partial fills). If the user wants it, it is a one-line hook in AddServiceRecordSheet's save — capture the decision on the board, don't slip it in.
8. **GPS data dependence (#179):** distance/banner only work for anchored locations (programmatic creates write NULL coords). Degradation is silent by design; set expectations at the hotload review.
9. **Preset churn (#177):** dashboard defaults are subjective — the ADMIN_LAYOUT "got rid of all my buttons" incident is the precedent. Treat W5A's hotload as a live review with one-line tweaks before merge; never touch ADMIN_LAYOUT.
10. **Theme coverage:** every new surface (OdometerRoll, trail pills, disable-reason text, batch return rows) must be checked under Futuristic (dark) and the `__DEV__` debug theme — unmigrated tokens scream in debug by design.
11. **README staleness:** `ui/README.md`'s "absent" list is wrong about `safe-area-context`/`keyboard-controller` (both installed). The binding rule is: nothing native beyond current `package.json`. Don't "fix" the README mid-wave; it's a standalone doc commit if desired.