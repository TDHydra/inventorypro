# InventoryPro Completeness Push — Implementation Plan (Parallel)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. **Verification gate:** this React-Native/Expo app and the Fastify API have **no unit-test runner**; the gate per task is `npx tsc --noEmit` clean (run by the controller, app-wide) + the task's explicit manual/curl check. Implementer agents do **NO git and NO tsc** — the controller runs unified tsc, commits per task, and reviews.

**Goal:** Drive jobs, locations, users/roles+teams, and equipment to feature-complete, close the audit-logging holes, and add real server-side permission enforcement.

**Architecture:** Three foundation tasks (job-model migration 008, server permission lib, log-query layer + ActivityFeed) land first; six feature waves then run as parallel subagents over a disjoint file-ownership map. Logging is device-side at each mutation call site; the API gains a `requirePermission()` preHandler.

**Tech Stack:** Expo SDK 56, `@op-engineering/op-sqlite`, expo-router, Fastify, `@fastify/jwt`, `@fastify/postgres`, Postgres 16.

## Global Constraints

- Expo SDK 56 — consult `https://docs.expo.dev/versions/v56.0.0/` before native/API code.
- op-sqlite bind params accept only `string | number | null | ArrayBuffer`. Booleans = `0/1` locally; send **real booleans** in outbox payloads.
- `appendLog(entry)` self-enqueues its own `activity_log` outbox row — never separately outbox an activity_log row.
- Logging is device-side at the call site (`useSession().user.id`); for online-only admin ops, log **after** the API call succeeds. `device_id: null`.
- Additive migrations only; next version = **008**; register in `loadMigrations()` (`apps/mobile/src/db/schema.ts`), version-ordered. Postgres mirror in `apps/api/src/db/migrations/008_*.sql`.
- Soft-delete: jobs `status='archived'`, locations `active=0`, units `status='retired'`. Lists filter them.
- `applyEntry` UPDATE is partial — safe to send `{id, field, updated_at}`.
- Equipment already logs `add_stock/add_units/repair_out/repair_in/checkout_to_job/transfer/checkin/consumed` — **do not duplicate**.
- Full Shared Context Pack (field/signature/route tables) lives in the spec:
  `docs/superpowers/specs/2026-06-26-inventory-completeness-design.md`. Every task brief ships with it.

## New logging action vocabulary
`job_created, job_updated, job_archived, location_created, location_updated, location_archived,
location_restored, user_created, user_updated, user_role_changed, user_pin_reset,
user_permission_changed, role_min_pin_changed, team_created, team_updated, team_member_added,
team_member_removed, unit_edited, unit_retired`

## Migration-file shapes (copy exactly)
op-sqlite migration:
```ts
import { DB } from '@op-engineering/op-sqlite';
export const migration = {
  version: 8,
  up: (db: DB): void => {
    db.executeSync(`ALTER TABLE jobs ADD COLUMN job_number TEXT`);
    // …one executeSync per ADD COLUMN…
  },
};
```
Postgres migration = a single `008_*.sql` file (runner executes the whole file as one multi-statement query; dollar-quoted function bodies are fine).

---

# WAVE 0 — FOUNDATION (sequential-ish; merge before Wave 1)

## Task F1: Migration 008 — job work-order fields + auto job_number

**Files:**
- Create: `apps/mobile/src/db/migrations/008_job_workorder_fields.ts`
- Create: `apps/api/src/db/migrations/008_job_workorder_fields.sql`
- Modify: `apps/mobile/src/db/schema.ts` (register m008 in `loadMigrations()`)
- Modify: `apps/mobile/src/db/queries/jobs.ts` (`Job` interface + `upsertJob` columns + `updateJobFields` whitelist)
- Modify: `apps/api/src/routes/jobs.ts` (POST/PATCH accept new fields) — **NOTE: F2 also edits this file for guards; F1 runs first, F2 second, never parallel.**

**Interfaces — Produces:**
- `Job` gains: `job_number: string | null; customer_name: string | null; site_address: string | null; site_location_id: string | null; description: string | null`.
- `updateJobFields(id, fields)` accepts `{name?, status?, job_number?, customer_name?, site_address?, site_location_id?, description?}`.

- [ ] **Step 1: op-sqlite migration 008.** Create the file:
```ts
import { DB } from '@op-engineering/op-sqlite';
export const migration = {
  version: 8,
  up: (db: DB): void => {
    db.executeSync(`ALTER TABLE jobs ADD COLUMN job_number TEXT`);
    db.executeSync(`ALTER TABLE jobs ADD COLUMN customer_name TEXT`);
    db.executeSync(`ALTER TABLE jobs ADD COLUMN site_address TEXT`);
    db.executeSync(`ALTER TABLE jobs ADD COLUMN site_location_id TEXT`);
    db.executeSync(`ALTER TABLE jobs ADD COLUMN description TEXT`);
  },
};
```
- [ ] **Step 2: register m008** in `apps/mobile/src/db/schema.ts` `loadMigrations()`: add
  `const { migration: m008 } = await import('./migrations/008_job_workorder_fields');` and include `m008` in the returned array.
- [ ] **Step 3: Postgres migration** `008_job_workorder_fields.sql`:
```sql
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_number TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS customer_name TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS site_address TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS site_location_id UUID REFERENCES locations(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS description TEXT;

CREATE SEQUENCE IF NOT EXISTS jobs_job_number_seq;

CREATE OR REPLACE FUNCTION assign_job_number() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.job_number IS NULL THEN
    NEW.job_number := nextval('jobs_job_number_seq')::text;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_assign_job_number ON jobs;
CREATE TRIGGER trg_assign_job_number BEFORE INSERT ON jobs
  FOR EACH ROW EXECUTE FUNCTION assign_job_number();
```
- [ ] **Step 4: extend `Job` + `upsertJob` + `updateJobFields`** in `queries/jobs.ts`. Add the 5 fields to the
  `Job` interface (all `string | null`). `upsertJob` INSERT OR REPLACE must list the new columns (read existing
  function, append columns + bind params, defaulting undefined→null). `updateJobFields` whitelist must accept the
  new fields (only set provided ones; keep partial-update shape and the existing `appendOutbox('UPDATE','jobs',…)`).
  `job_number` is **never written by the device on create** (leave null → server trigger assigns).
- [ ] **Step 5: API POST/PATCH /jobs** in `routes/jobs.ts`: extend the JSON body schema + INSERT/UPDATE column
  lists to accept `customer_name, site_address, site_location_id, description` (and `job_number` on PATCH only).
  Do **not** include job_number in the POST insert column list (let the trigger assign). Keep `created_by = request.user.sub`.
- [ ] **Step 6 (controller): verify.** `cd apps/mobile && npx tsc --noEmit` clean. `cd apps/api && npx tsc --noEmit` clean.
  Apply migration locally: API boots → `schema_migrations` has 008; insert a job via `POST /jobs` with null job_number →
  row comes back/syncs with a numeric `job_number`. Mobile: fresh DB logs `SQLite schema v8 ready`.
- [ ] **Step 7 (controller): commit** `feat(jobs): migration 008 work-order fields + server-assigned job_number`.

## Task F2: Server-side permission enforcement

**Files:**
- Create: `apps/api/src/lib/permissions.ts`
- Modify: `apps/api/src/routes/jobs.ts`, `routes/locations.ts`, `routes/users.ts`, `routes/teams.ts`, `routes/items.ts`
- Reference: port `ROLE_DEFAULTS` from `apps/mobile/src/constants/roles.ts` (read it; do not guess keys)

**Interfaces — Produces:**
- `userHasPermission(role: string, overrides: Record<string,boolean>, perm: string): boolean`
- `requirePermission(perm: string)` → Fastify preHandler `(request, reply) => Promise<void>` that 403s on failure.

- [ ] **Step 1: read** `apps/mobile/src/constants/roles.ts` and copy the exact `ROLE_DEFAULTS` map + permission key
  list verbatim into `permissions.ts` (header comment: `// KEEP IN SYNC with apps/mobile/src/constants/roles.ts`).
- [ ] **Step 2: implement** `permissions.ts`:
```ts
import { FastifyRequest, FastifyReply } from 'fastify';
// KEEP IN SYNC with apps/mobile/src/constants/roles.ts
export const ROLE_DEFAULTS: Record<string, Record<string, boolean>> = { /* …verbatim… */ };
export function userHasPermission(role: string, overrides: Record<string, boolean> | null, perm: string): boolean {
  if (overrides && perm in overrides) return !!overrides[perm];      // user override wins
  return ROLE_DEFAULTS[role]?.[perm] ?? false;
}
export function requirePermission(perm: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const userId = (request.user as { sub: string }).sub;
    const { rows } = await (request.server as any).pg.query(
      'SELECT role, permission_overrides FROM users WHERE id = $1', [userId]);
    const u = rows[0];
    if (!u || !userHasPermission(u.role, u.permission_overrides, perm)) {
      reply.status(403).send({ error: 'Forbidden' });
    }
  };
}
```
- [ ] **Step 3: wire guards** — add to each route's `preHandler` array AFTER `authenticate`:
  - `POST /jobs` → `requirePermission('create_jobs')`; `PATCH /jobs/:id` → `requirePermission('close_jobs')`
  - `POST /locations` + `PATCH /locations/:id` → `requirePermission('manage_locations')`
  - `POST /users` → `requirePermission('manage_users')` (keep existing ADMIN_ROLES on GET/PATCH)
  - all `/teams` writes (POST, PATCH, member add/remove) → `requirePermission('manage_teams')`
  - `POST /items` + `PATCH /items/:id` → `requirePermission('add_inventory')`/`requirePermission('edit_inventory')`;
    `POST /items/:id/stock` → `requirePermission('add_inventory')`
  Leave all GET routes unguarded (auth only).
- [ ] **Step 4 (controller): verify.** `cd apps/api && npx tsc --noEmit` clean. Curl prod-like: mint a tier-1 JWT →
  `POST /jobs` returns **403**; admin JWT → **200/201**. (Controller uses the real JWT_SECRET via
  `docker exec inventorypro-api-1 printenv JWT_SECRET`.)
- [ ] **Step 5 (controller): commit** `feat(api): server-side requirePermission guards on writes`.

## Task F3: Log-query layer + ActivityFeed component

**Files:**
- Modify: `apps/mobile/src/db/queries/log.ts`
- Create: `apps/mobile/src/components/ActivityFeed.tsx`

**Interfaces — Produces:**
- `getLogForEntity(entityType: string, entityId: string, limit?: number): LogEntry[]` (joins `user_name`)
- `getRecentLog(limit?: number): LogEntry[]` (all, newest first, joins `user_name`)
- `getLogFiltered(f: { userId?: string; action?: string; sinceISO?: string; untilISO?: string }, limit?: number): LogEntry[]`
- `<ActivityFeed entityType={string} entityId={string} limit?={number} />` React component
- Exported `ACTION_ICONS` + `actionLabel(action)` helper (so W6 reuses them)

- [ ] **Step 1: add queries** to `log.ts` (follow existing `getLogForJob` join style; `rowsAs<LogEntry & {user_name?:string}>`):
```ts
export function getLogForEntity(entityType: string, entityId: string, limit = 50): LogEntry[] {
  const db = getDb();
  const r = db.executeSync(
    `SELECT al.*, u.name AS user_name FROM activity_log al
     LEFT JOIN users u ON u.id = al.user_id
     WHERE al.entity_type = ? AND al.entity_id = ? ORDER BY al.created_at DESC LIMIT ?`,
    [entityType, entityId, limit]);
  return rowsAs<LogEntry>(r.rows);
}
export function getRecentLog(limit = 100): LogEntry[] { /* same join, no WHERE, LIMIT ? */ }
export function getLogFiltered(f: {...}, limit = 200): LogEntry[] {
  // dynamic WHERE: al.user_id = ?, al.action = ?, al.created_at >= ?, al.created_at <= ?
  // build clauses + params array conditionally; always ORDER BY created_at DESC LIMIT ?
}
```
- [ ] **Step 2: ActivityFeed component** — move the row-render + `ACTION_ICONS` out of `(logs)/index.tsx` style into
  a reusable component. Export `ACTION_ICONS` (extended with every new action verb → an emoji/glyph) and
  `actionLabel(a) = a.replace(/_/g,' ')`. Component calls `getLogForEntity(entityType, entityId, limit)`, renders a
  vertical list (icon, label, user_name, qty/unit if present, note, relative date), with an empty state.
- [ ] **Step 3 (controller): verify.** `cd apps/mobile && npx tsc --noEmit` clean. (No runtime test harness; visual
  check happens when W2/W3 mount it.)
- [ ] **Step 4 (controller): commit** `feat(log): entity/recent/filtered queries + reusable ActivityFeed`.

---

# WAVE 1 — FEATURE WORKSTREAMS (parallel; disjoint files)

> Each task below is dispatched to its own implementer agent **after Wave 0 is merged**. Briefs carry the
> Shared Context Pack. Agents edit only the files under their ownership. Controller runs app-wide `tsc`,
> commits per task, reviews each, then whole-branch review before merge.

## Task W1: Jobs — create/edit screens + work-order fields + logging
**Owns:** `app/(app)/(jobs)/create.tsx` (new), `app/(app)/(jobs)/[id].tsx`, `app/(app)/(jobs)/index.tsx`
**Consumes:** F1 (`Job` fields, `updateJobFields`), `appendLog`, `usePermission`.
- [ ] Add a FAB/"+ New Job" on `(jobs)/index.tsx`, gated `usePermission('create_jobs')`, → `router.push('/(app)/(jobs)/create')`.
- [ ] New `create.tsx`: form for `name` (required), `customer_name`, `site_address`, `site_location_id`
  (SearchablePicker of locations), `description`; status defaults `open`. On save: `upsertJob({...,
  job_number: null, status:'open', created_by: user.id, ...})` + `appendOutbox('INSERT','jobs', payload)` +
  `appendLog({action:'job_created', entity_type:'job', entity_id:id, user_id:user.id, note: name, …nulls})`.
  Show a hint that the job number is assigned after sync.
- [ ] `[id].tsx`: render `job_number` (or "Pending #"), customer/address/description in the header card. Extend the
  edit modal to all work-order fields → `updateJobFields(id, fields)` + `appendLog('job_updated')`. Archive button →
  `archiveJob(id)` + `appendLog('job_archived')`. (Activity feed already present via `getLogForJob`.)
- [ ] **Inline-create logging:** in `(checkout)/index.tsx` job-create path — **out of W1's ownership (W-checkout already
  logs movements); leave a note for the controller to add `job_created` there in the integration pass** to avoid a
  file collision with the equipment flow. (Do NOT edit checkout in W1.)
- [ ] Verification: tsc clean; create job → appears with Pending # then a number after sync; edit/archive logged.

## Task W2: Locations — edit/unarchive + move-stock + activity feed + logging
**Owns:** `app/(app)/(locations)/index.tsx`, `app/(app)/(locations)/[id].tsx`, `src/db/queries/locations.ts`, `src/components/MoveStockModal.tsx` (new)
**Consumes:** F3 (`ActivityFeed`), `appendLog`, `adjustStock`, `upsertLocation`.
- [ ] `(locations)/index.tsx`: on create, add `appendLog({action:'location_created', entity_type:'location', entity_id:id, user_id, note:name})`.
- [ ] `(locations)/[id].tsx`: **Edit** modal (name/color/icon/parent/owner) mirroring the create modal →
  `upsertLocation({...changes, active:1})` + `appendOutbox('UPDATE','locations', {id,...changes, active:true, updated_at})` +
  `appendLog('location_updated')`. **Unarchive** button (shown when `active=0`) → set `active=1` + outbox UPDATE +
  `appendLog('location_restored')`. Existing archive button → add `appendLog('location_archived')`. Add
  `<ActivityFeed entityType="location" entityId={id} />` section.
- [ ] New `MoveStockModal.tsx` (opened from location detail): pick item (from this location's stock), to-location
  (SearchablePicker), qty (≤ on-hand). On confirm: `adjustStock(itemId, fromLocId, -qty)`, `adjustStock(itemId, toLocId, +qty)`,
  outbox UPDATE both `stock_by_location` rows, `appendLog({action:'transfer', entity_type:'item', entity_id:itemId,
  from_location_id:fromLocId, to_location_id:toLocId, quantity:qty, unit})`.
- [ ] Verification: tsc clean; edit persists; unarchive flips active; move-stock math balances; transfer logged.

## Task W3: Equipment — unit edit/retire + maintenance history
**Owns:** `app/(app)/(inventory)/[id].tsx`
**Consumes:** F3 (`getLogForEntity`/`ActivityFeed`), `setUnitStatus`, `upsertUnit`, `appendLog`.
- [ ] In the per-unit row (unit_tracked items), add **Edit** (asset_tag/serial/notes) → `upsertUnit({...unit, ...changes})` +
  outbox UPDATE `equipment_units` + `appendLog({action:'unit_edited', entity_type:'equipment_unit', entity_id:unit.id, note})`.
- [ ] Add **Retire** action → `setUnitStatus(unit.id, {status:'retired'})` + outbox + `appendLog('unit_retired')`.
  Retired units render greyed and are excluded from available counts (verify `countUnitsByStatus`/pickers already exclude non-available).
- [ ] Add per-unit **History** view: `<ActivityFeed entityType="equipment_unit" entityId={unit.id} />` (shows
  add/deploy/return/repair/retire timeline already logged). Reachable from the unit row.
- [ ] Verification: tsc clean; edit/retire mutate + log; history lists prior repair_out/in + retire.

## Task W4: Users/Admin — logging + permission-UI completeness
**Owns:** `app/(app)/(admin)/users.tsx`, `app/(app)/(admin)/roles.tsx`
**Consumes:** `appendLog`, existing `updateUserLocal`/`markUserPinReset`/`setRoleMinPin`.
- [ ] `users.tsx`: add `view_financial_data` + `system_settings` to the `ALL_PERMISSIONS` toggle list (labels match roles.ts).
- [ ] Wire logging (after the existing local write/outbox/API call succeeds), all `entity_type:'user'`, `entity_id:userId`:
  `user_created` (after `POST /users` ok), `user_updated` (name/active/expiry edits), `user_role_changed` (when role
  changes), `user_pin_reset` (after reset), `user_permission_changed` (override toggle save). `user_id:` = the **acting
  admin** (`session user.id`); put the target user in `entity_id` and a `note`.
- [ ] `roles.tsx`: on `setRoleMinPin`, `appendLog({action:'role_min_pin_changed', entity_type:'role_settings',
  entity_id:role, user_id:adminId, note:`${role}→${n}`})`.
- [ ] Verification: tsc clean; toggles include the 2 new perms; each admin mutation produces a log row.

## Task W5: Teams — queries + roster/member-assignment screens + logging
**Owns:** `app/(app)/(teams)/index.tsx`, `app/(app)/(teams)/[id].tsx`, `src/db/queries/teams.ts` (new)
**Consumes:** `appendOutbox`, `appendLog`, `getAllActiveUsers`, `usePermission('manage_teams')`, `SearchablePicker`.
- [ ] New `queries/teams.ts`: interfaces `Team{id,name,type,manager_id,updated_at,synced_at}`,
  `TeamMember{team_id,user_id,team_permission_overrides,added_by,joined_at}`; functions `getAllTeams()`,
  `getTeamById(id)`, `getTeamMembers(teamId)` (join user name/role), `upsertTeam(team)`, `addTeamMember(teamId,
  userId, overrides={})`, `removeTeamMember(teamId, userId)` — each local write + matching `appendOutbox` (INSERT/DELETE;
  team_members conflict key is composite `(team_id,user_id)`).
- [ ] `(teams)/index.tsx`: list teams; **Create** modal (name, type, manager via SearchablePicker), gated
  `manage_teams` → `upsertTeam` + outbox INSERT + `appendLog('team_created')`.
- [ ] `(teams)/[id].tsx` (replace stub): header (name/type/manager, editable → `team_updated`), roster from
  `getTeamMembers`, **Add member** (SearchablePicker of active users) → `addTeamMember` + `appendLog('team_member_added')`,
  **Remove** per row → `removeTeamMember` + `appendLog('team_member_removed')`. All `entity_type:'team'`, `entity_id:teamId`.
- [ ] Verification: tsc clean; create team, add/remove member → roster updates, logged; survives a sync round-trip.

## Task W6: Logs UI — All-Activity admin view + filters
**Owns:** `app/(app)/(logs)/index.tsx`
**Consumes:** F3 (`getRecentLog`, `getLogFiltered`, `ACTION_ICONS`, `actionLabel`), `usePermission('view_all_logs')`.
- [ ] Add a third filter chip **"All Activity"** (only rendered if `usePermission('view_all_logs')`), backed by
  `getRecentLog()`/`getLogFiltered()`. Keep existing "My Activity" / "Pending Sync".
- [ ] Add filter controls for the All-Activity view: user (SearchablePicker of users), action (picker of the
  action vocabulary), and a date range (from/to). Compose into `getLogFiltered({userId, action, sinceISO, untilISO})`.
- [ ] Reuse `ACTION_ICONS`/`actionLabel` from F3 (delete the local copies in this file).
- [ ] Verification: tsc clean; admin sees cross-entity events; filters narrow; non-admin never sees the All-Activity chip.

---

# INTEGRATION PASS (controller, after W1–W6 merge to branch)
- [ ] Add `job_created` logging to the inline job-create path in `(checkout)/index.tsx` (deferred from W1 to avoid a
  file collision with the equipment movement flow). One `appendLog` after the `upsertJob`/outbox there.
- [ ] App-wide `npx tsc --noEmit` (mobile + api) clean.
- [ ] Whole-branch review (opus) of the full diff vs. the spec.
- [ ] Deploy: build API image `--no-cache`, push, migrate 008 on prod Postgres, verify `schema_migrations` has 008 +
  a `POST /jobs` assigns a number + tier-1 guard returns 403. Rebuild + install APK (prod URL baked).

---

## Self-Review (controller checklist before execution)
- **Spec coverage:** A=F2; B=W1/W2/W3/W4/W5 logging + integration pass; C=F3+W2+W3+W6; D=W1(create/edit)+W2(edit/unarchive)+W3(unit edit/retire/history)+W5(teams); E=W2 MoveStockModal; F=W4. Job model=F1. ✔ every spec item maps.
- **Placeholder scan:** the only non-literal code blocks are F3 `getRecentLog`/`getLogFiltered` bodies (pattern given) and `ROLE_DEFAULTS` (port verbatim from the named file) — both explicitly sourced, not "TBD".
- **Type consistency:** `Job` fields (F1) match W1 usage; `getLogForEntity`/`ActivityFeed` signatures (F3) match W2/W3/W6 usage; `requirePermission` (F2) matches Step-3 wiring; teams interfaces (W5) self-contained.
- **File-collision check:** `queries/jobs.ts` (F1) and `routes/jobs.ts` (F1+F2) are touched only in Wave 0, sequentially. `(checkout)/index.tsx` is touched only in the integration pass, not W1. All Wave-1 ownership disjoint. ✔
