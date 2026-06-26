# InventoryPro Completeness Push — Design Spec

*Date: 2026-06-26* · *Branch: `feat/inventory-completeness`*

## Context

The core inventory app is live in production (api.plexcontrol.com, migrations 001–007,
s3 media working, standalone APK in field use). This push drives the four named
subsystems — **jobs, locations, users/roles (+teams), equipment** — to "as complete as
possible," and closes the cross-cutting gaps a four-agent recon sweep surfaced:
server-side permission enforcement, audit-logging holes, and missing edit/create/viewing
screens.

### Decisions locked with the user
1. **Harden the API** — add real server-side permission enforcement (role checks are
   currently client-only).
2. **Expand jobs into real work-orders** — customer, site address, dates, etc. (migration 008).
3. **Build teams out** — replace the stub team screens with real roster/member management.

## Global Constraints (apply to every task)

- **Expo SDK 56** — consult `https://docs.expo.dev/versions/v56.0.0/` before native/API code.
- **op-sqlite bind params** accept only `string | number | null | ArrayBuffer`. Booleans are
  `0/1` in local SQLite; send **real booleans** in outbox payloads (server columns are BOOLEAN).
- **`appendLog(entry)`** self-enqueues its own `activity_log` outbox row — never separately
  outbox an activity_log row.
- **Logging is device-side at the call site** (where `useSession` gives `user.id`). For
  online-only admin ops (e.g. `POST /users`), call `appendLog` **after** the API call succeeds.
  `device_id: null` per existing convention.
- **Additive migrations only**: Postgres `ALTER` + op-sqlite `ALTER` + register in
  `loadMigrations()` (`apps/mobile/src/db/schema.ts`), version-ordered. Next version = **008**.
- **Soft-delete** pattern: jobs `status='archived'`, locations/items/units via `active`/`status`.
  Lists filter them out.
- **`applyEntry` UPDATE is a real partial update** (only changed columns) — safe to send
  `{id, field, updated_at}` without nulling siblings.
- Agents do **NO git** and **NO `tsc`** (controller runs unified tsc + commits per task) to
  avoid the concurrent-git race that swept `node_modules` last time.

---

## Shared Context Pack (authoritative — from recon)

### Logging — `apps/mobile/src/db/queries/log.ts`
```ts
appendLog(entry: Omit<LogEntry,'id'|'created_at'|'synced_at'>): void
// fields: user_id, team_id, action, entity_type, entity_id,
//   from_location_id, to_location_id, quantity, unit, job_id, note, metadata(JSON str), device_id
getLogForUser(userId, limit=50)   // already joins user_name
getLogForJob(jobId)               // joins user_name
getUnsyncedLogs(); markLogsSynced(ids)
```
Equipment already logs: `add_stock, add_units, repair_out, repair_in, checkout_to_job,
transfer, checkin, consumed`. **Do not duplicate these.**

### Jobs — `queries/jobs.ts` (current)
`Job{id,name,status:'open'|'closed'|'archived',created_by,created_at,updated_at,synced_at}`
`getOpenJobs() searchJobs(q) getJobById(id) upsertJob(job) getAllJobs(incArch=false)
archiveJob(id) updateJobFields(id,{name?,status?}) getJobDeployments(jobId) getActiveCheckoutsForUser(uid)`
- `upsertJob` does **not** outbox or log. `archiveJob`/`updateJobFields` outbox but **don't log**.
- API `routes/jobs.ts`: GET /jobs, GET /jobs/:id, POST /jobs, PATCH /jobs/:id — **JWT only, no role guard.**

### Locations — `queries/locations.ts`
`Location{id,name,parent_id,color,icon,owner_user_id,active(0/1),updated_at,synced_at}`
`getAllLocations getTopLevelLocations getSubAreas(pid) getLocationTree getLocationById(id)
getLocationsByOwner(uid) getStockAtLocation(locId):StockAtLocation[] upsertLocation(loc)`
- `upsertLocation` writes + caller outboxes; **no logging** on create/archive.
- API `routes/locations.ts`: GET, GET/:id, POST, PATCH — whitelist {name,parent_id,color,icon}, **no role guard.**

### Equipment — `queries/items.ts` + `queries/equipmentUnits.ts`
`EquipmentUnit{id,item_id,asset_tag,serial_number,status:'available'|'deployed'|'in_repair'|'retired',
current_location_id,current_job_id,notes,created_at,updated_at,synced_at}`
`getUnitsForItem getAvailableUnitsAtLocation getUnitByTag countUnitsByStatus
getDeployedUnitsForUser upsertUnit(u) setUnitStatus(unitId,{status,current_location_id?,current_job_id?,notes?})`
`items.ts: searchItems getItemById updateItemFields(id,partial) upsertStock adjustStock(itemId,locId,delta) getLowStockItems getDistinctValues`
- No dedicated `/equipment_units` route — units sync via outbox only (in ALLOWED + FULL tables).

### Users/Roles/Teams — `queries/users.ts`, `auth/permissions.ts`, `constants/roles.ts`
`User{id,name,role,pin_length_required,pin_set(0/1),permission_overrides(JSON str),active,expires_at,...}`
`getAllActiveUsers getAllUsers getUserById upsertUser updateUserLocal(id,fields):updated_at
markUserPinSet markUserPinReset getRoleSettings setRoleMinPin(role,n):updated_at getUsersByRole`
- `hasPermission(user,perm,teamId?)`: role default → team override → **user override wins**.
- 19 permission keys; `view_financial_data` + `system_settings` exist in ROLE_DEFAULTS but are
  **missing from the users.tsx toggle UI**.
- JWT payload carries `sub, name, role` (NOT overrides). DB lookup by `sub` for overrides.
- API guard precedent: `routes/users.ts:22` `ADMIN_ROLES`; `GET /users` checks it; `POST /users` does **not**.
- Teams: `routes/teams.ts` full CRUD + members, **all JWT-only no guard**; mobile `(teams)/index.tsx`
  list-only, `(teams)/[id].tsx` is a **stub**. `team_members` is in sync allowlist (offline-capable).

### Sync — `routes/sync.ts`
ALLOWED_TABLES + FULL_TABLES both include: users, role_settings, locations, inventory_items,
stock_by_location, jobs, teams, team_members, media, activity_log, equipment_units.
Jobs/locations/teams sync `SELECT *` → **new columns flow automatically, no sync code change.**
`users` SELECT omits `pin_hash`.

### Migrations — `apps/mobile/src/db/schema.ts` `loadMigrations()`
Static imports m001…m007; **add m008**, append to the returned array (sorted by version).
Postgres mirror in `apps/api/src/db/migrations/008_*.sql` (runner applies on boot).

---

## Workstreams

### FOUNDATION (Wave 0 — merges before feature waves)

**F1 — Migration 008: job work-order fields**
- `jobs` gains: `job_number TEXT` (nullable; auto-assigned when null — see below),
  `customer_name TEXT`, `site_address TEXT`, `site_location_id` (FK locations, nullable),
  `description TEXT`. (Schedule/priority intentionally **dropped** per user.)
- **`job_number` auto-increment (offline-safe):** a device-side counter would collide across
  offline devices, so the **server** is authoritative. Postgres: `CREATE SEQUENCE jobs_job_number_seq`
  + a `BEFORE INSERT` trigger that sets `job_number = nextval(...)::text` **only when NULL**. This
  fires for both `POST /jobs` and `sync/push` INSERTs. A user-typed value is kept verbatim.
  The mobile create flow leaves it null by default and shows **"Pending #"** until the next
  `sync/pull` returns the assigned number (jobs sync `SELECT *`, server-wins → populates locally;
  the trigger sets it at insert time so the row's `updated_at` carries it into the pull window).
- Files: `apps/mobile/src/db/migrations/008_job_workorder_fields.ts` (op-sqlite `ALTER TABLE jobs ADD COLUMN …`),
  `apps/api/src/db/migrations/008_job_workorder_fields.sql` (Postgres `ALTER` + sequence + trigger),
  register m008 in `schema.ts`.
- Update `Job` interface + `upsertJob` + `updateJobFields` to carry new fields (still partial-update safe).

**F2 — Server permission enforcement**
- New `apps/api/src/lib/permissions.ts`: port `ROLE_DEFAULTS` + tier map from
  `apps/mobile/src/constants/roles.ts` (header comment: "keep in sync with mobile"), and a
  `userHasPermission(role, overrides, perm)` matching mobile resolution (role default → user override).
- New `requirePermission(perm)` Fastify preHandler factory: loads `{role, permission_overrides}`
  from Postgres by `request.user.sub`, 403 if `!userHasPermission`. Mirrors `users.ts:29-36`.
- Apply guards: `POST/PATCH /jobs` → `create_jobs`/`close_jobs`; `POST/PATCH /locations` →
  `manage_locations`; `POST /users` → admin (reuse ADMIN_ROLES or `manage_users`); all `/teams`
  writes → `manage_teams`; `POST /items`+`PATCH /items/:id`+`/items/:id/stock` → `add_inventory`/`edit_inventory`.
- Backwards-safe: GET routes unchanged.

**F3 — Log query layer + ActivityFeed**
- `queries/log.ts`: add `getLogForEntity(entityType, entityId, limit=50)` (joins user_name),
  `getRecentLog(limit=100)` (all, newest first, joins user_name),
  `getLogFiltered({userId?,action?,sinceISO?,untilISO?}, limit=200)`; add user_name join to `getLogForUser`.
- New `apps/mobile/src/components/ActivityFeed.tsx`: props `{entityType, entityId, limit?}`,
  renders log rows (icon, action label, qty/unit, note, user, relative date). Reused by
  location + item detail. Extend `ACTION_ICONS` with new actions.

### FEATURE WAVES (Wave 1 — parallel, disjoint file ownership)

**W1 — Jobs**
- New `app/(app)/(jobs)/create.tsx` (name + work-order fields + status); add FAB on `(jobs)/index.tsx`
  gated by `usePermission('create_jobs')`.
- `(jobs)/[id].tsx`: render work-order fields; edit modal extended to all fields; wire logging:
  `job_created` (create.tsx + checkout inline-create), `job_updated` (edit/archive→updateJobFields),
  `job_archived` (archiveJob). Make `upsertJob`/`archiveJob`/`updateJobFields` outbox+log consistently.
- Owns: `(jobs)/create.tsx`, `(jobs)/[id].tsx`, `(jobs)/index.tsx`, `queries/jobs.ts`.

**W2 — Locations**
- `(locations)/[id].tsx`: add **Edit** modal (name/color/icon/parent/owner) → upsertLocation + outbox UPDATE +
  `location_updated`; **Unarchive** button when `active=0` → `location_restored`; add `<ActivityFeed entityType="location" entityId={id}/>`.
- `(locations)/index.tsx`: wire `location_created` log on create.
- New **Move Stock** modal (entry from location detail): item + from/to loc + qty →
  `adjustStock(-q)`/`adjustStock(+q)` + outbox both stock rows + `appendLog('transfer', from/to, qty, unit)`.
- Owns: `(locations)/index.tsx`, `(locations)/[id].tsx`, `queries/locations.ts`, new `components/MoveStockModal.tsx`.

**W3 — Equipment**
- `(inventory)/[id].tsx`: per-unit **Edit** modal (asset_tag/serial/notes) → upsertUnit + `unit_edited`;
  **Retire** action → `setUnitStatus('retired')` + `unit_retired`; per-unit **history** view via
  `getLogForEntity('equipment_unit', unitId)` (repair/deploy/return/retire timeline).
- Owns: `(inventory)/[id].tsx` only (no overlap with W-checkout flows, which already log).

**W4 — Users/Admin**
- `(admin)/users.tsx`: add `view_financial_data` + `system_settings` to `ALL_PERMISSIONS`; wire logging:
  `user_created` (after POST /users ok), `user_updated`, `user_role_changed`, `user_pin_reset`,
  `user_permission_changed`.
- `(admin)/roles.tsx`: `role_min_pin_changed` log on setRoleMinPin.
- Owns: `(admin)/users.tsx`, `(admin)/roles.tsx`.

**W5 — Teams**
- New `queries/teams.ts`: `Team`/`TeamMember` interfaces; `getAllTeams getTeamById getTeamMembers(teamId)
  upsertTeam(team) addTeamMember(teamId,userId,overrides) removeTeamMember(teamId,userId)` — local writes + outbox.
- `(teams)/index.tsx`: list + create modal (name/type/manager) gated by `manage_teams`.
- `(teams)/[id].tsx`: roster, add/remove members (SearchablePicker of users), manager + team perm overrides;
  logging `team_created/updated/member_added/member_removed`.
- Owns: `(teams)/index.tsx`, `(teams)/[id].tsx`, `queries/teams.ts`.

**W6 — Logs viewing UI**
- `(logs)/index.tsx`: add **All Activity** filter (gated `view_all_logs`) backed by `getRecentLog`/`getLogFiltered`;
  add date-range + user + action filter chips. Reuse `ACTION_ICONS` (extended in F3).
- Owns: `(logs)/index.tsx`.

### Logging action vocabulary (new)
`job_created, job_updated, job_archived, location_created, location_updated, location_archived,
location_restored, user_created, user_updated, user_role_changed, user_pin_reset,
user_permission_changed, role_min_pin_changed, team_created, team_updated, team_member_added,
team_member_removed, unit_edited, unit_retired` — `entity_type` = the entity (`job`/`location`/`user`/`team`/`equipment_unit`).

---

## File-ownership map (no two parallel tasks share a file)

| Wave | Owns |
|---|---|
| F1 | `migrations/008_*.ts`, `migrations/008_*.sql`, `schema.ts` (register), `queries/jobs.ts` (interface+upsert) |
| F2 | `apps/api/src/lib/permissions.ts` (new), `routes/jobs.ts`, `routes/locations.ts`, `routes/users.ts`, `routes/teams.ts`, `routes/items.ts` |
| F3 | `queries/log.ts`, `components/ActivityFeed.tsx` (new) |
| W1 | `(jobs)/create.tsx` (new), `(jobs)/[id].tsx`, `(jobs)/index.tsx` |
| W2 | `(locations)/index.tsx`, `(locations)/[id].tsx`, `queries/locations.ts`, `components/MoveStockModal.tsx` (new) |
| W3 | `(inventory)/[id].tsx` |
| W4 | `(admin)/users.tsx`, `(admin)/roles.tsx` |
| W5 | `(teams)/index.tsx`, `(teams)/[id].tsx`, `queries/teams.ts` (new) |
| W6 | `(logs)/index.tsx` |

**Ordering:** F1+F2+F3 land first (W1 needs F1's Job interface; W2/W3/W6 need F3; F2 is independent backend).
W1–W6 then run in parallel. `queries/jobs.ts` is touched by F1 (interface) then W1 (logging) — **sequential, not parallel** (W1 after F1). All other ownership is disjoint.

## Execution model
Subagent-driven-development: controller branches (`feat/inventory-completeness`, done), writes
task briefs each carrying this Shared Context Pack, dispatches one implementer + one reviewer per
task. Foundation wave first (F1→F2→F3, F2 parallel to F1/F3). Then W1–W6 parallel. Controller runs
unified `tsc` across the app after each wave, commits per task, runs per-task review, then a
whole-branch opus review before merge. Deploy migration 008 + API guards to prod after merge;
rebuild APK.

## Verification
- `tsc` clean across `apps/mobile` and `apps/api`.
- Migration 008 applies cleanly on a fresh sqlite DB (schema v8 log) and on Postgres.
- Manual: create job with work-order fields, leave job_number blank → after sync it shows a
  server-assigned sequential number (was "Pending #"); a typed job_number is preserved; edit/archive logged.
- Location edit + unarchive + move-stock → stock math correct, transfer logged, both stock rows outboxed.
- Unit retire + edit → status/fields change, history timeline shows it.
- API guard: tier-1 JWT `POST /jobs` → 403; admin → 200 (curl against prod-like).
- Teams: create team, add/remove member → roster updates, logged, survives sync round-trip.
- Logs: All-Activity view (admin) lists cross-entity events; filters narrow correctly; non-admin can't see it.

## Out of scope (backlog)
Multi-parent locations, job batch ops, bulk user ops, push notifications for low-stock/expiry,
camera barcode-scan for tags, role-definition runtime editor, label templates/auto-gen tags.
