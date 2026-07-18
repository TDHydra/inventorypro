# Notifications Platform #3/#4/#5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan is executed as an UltraMode Workflow: Task 1→2 serial (foundation), then Tasks 3/4/5/6 in parallel (disjoint files), then Task 7 (depends on 5+6).

**Goal:** Ship the last three notifications sub-projects — admin-configurable routing rules (#3), a broadcast composer with a new `send_notifications` permission (#4), and an approvals workflow (#5) — on a new shared in-app **inbox** foundation.

**Architecture:** A single `deliver(pg, userIds, payload)` funnel writes a durable per-user `notifications` inbox row AND fires `sendPush` as a nudge. The three existing #2 triggers refactor to call it. Two new synced tables: `notifications` (per-user, pull-scoped, client-immutable except `read_at`) and `approval_requests` (org-wide, two-way). Routing rules live in synced `app_config` JSON; broadcasts and approval decisions fan out through `deliver`.

**Tech Stack:** Fastify v4 + Postgres (API), Expo SDK 56 + op-sqlite/sql.js (mobile), `node:test` unit tests, Expo Push via existing `sendPush`.

## Global Constraints
- **Migration numbers:** API next = **032**, mobile next = **025**. (API max currently 031, mobile 024.)
- **Sync parity (every synced column):** API migration + mobile migration registered in **both** `apps/mobile/src/db/schema.ts` AND `apps/mobile/src/db/schema.web.ts`; `apps/api/src/routes/pull.ts`… — NOTE: pull logic lives in `apps/api/src/routes/sync.ts` (there is no separate pull.ts). Add table to `ALLOWED_TABLES`, `FULL_TABLES`, `CONFLICT_TARGETS` as needed; `selectColumnsFor` in `apps/api/src/lib/syncPolicy.ts`; and the mobile upsert (`TABLE_UPSERT_SQL` + `rowToValues`) in `apps/mobile/src/sync/pull.ts` — **column count == placeholder count**.
- **No PII in push payloads:** titles/bodies are fixed templates (triggers/approvals), the sender's text (broadcast), or item *names* + counts only — never customer content or field values.
- **Every server notification hook is `try/catch`-wrapped** — a notification failure must never break `/sync/push` or crash the timer.
- **Verify each task:** `cd apps/api && npx tsc --noEmit && npm test`; `cd apps/mobile && npx tsc --noEmit`.
- **No secrets committed.** Do not deploy — prod deploy is user-gated.

---

## File Structure

**API (`apps/api/src`)**
- `db/migrations/032_notifications_and_approvals.sql` — CREATE both tables (**new**).
- `lib/notifications.ts` — add `deliver()`, `resolveRecipients()`, dedup keys `approval`/`apprDecision`; refactor `notifyLowStock` to `deliver` (**modify**).
- `lib/notifications.test.ts` — add resolver + deliver + dedup tests (**modify**).
- `lib/syncPolicy.ts` — `selectColumnsFor`, `SENSITIVE_DENY`, `OPERATION_PERM`, `applyWritePolicy` rules for the two tables (**modify**).
- `lib/notificationTimer.ts` — checkout-idle uses `deliver` (**modify**).
- `routes/sync.ts` — register tables in `ALLOWED_TABLES`/`FULL_TABLES`/`CONFLICT_TARGETS`; `SCOPED_TABLES` + scoped pull; assignment hook → `deliver`; approval push hooks + threshold auto-flag (**modify**).
- `routes/notifications.ts` — `POST /notifications/broadcast` (**new**).
- `routes/notifications.test.ts` — broadcast audience tests (**new**).
- `index.ts` — register `/notifications` routes (**modify**).
- `lib/permissions.ts` — mirror `send_notifications` (**modify**).

**Mobile (`apps/mobile`)**
- `src/db/migrations/025_notifications_and_approvals.ts` — CREATE both tables (**new**).
- `src/db/schema.ts` + `src/db/schema.web.ts` — register migration 025 (**modify both**).
- `src/sync/pull.ts` — `TABLE_UPSERT_SQL` + `rowToValues` for both tables (**modify**).
- `src/constants/roles.ts` — `send_notifications` in `Permission` + 4 tier maps (**modify**).
- `src/db/queries/notifications.ts` — inbox queries + mark-read + `countUnread` + `createApprovalRequest` + `decideApproval` (**new**).
- `src/db/queries/appConfig.ts` (or existing config query file) — routing-rule + threshold config getters/setters (**modify/confirm path**).
- `app/(app)/(notifications)/index.tsx` + `_layout.tsx` — inbox list (**new**).
- `app/(app)/(admin)/settings.tsx` — routing-rules section + threshold input (**modify**).
- `app/(app)/(admin)/broadcast.tsx` — compose screen (**new**).
- `src/components/NotificationBell.tsx` — header unread badge (**new**).
- `src/components/RequestApprovalSheet.tsx` — manual request UI (**new**).

---

## Task 1: Synced tables — `notifications` + `approval_requests` (foundation)

**Files:**
- Create: `apps/api/src/db/migrations/032_notifications_and_approvals.sql`
- Create: `apps/mobile/src/db/migrations/025_notifications_and_approvals.ts`
- Modify: `apps/mobile/src/db/schema.ts`, `apps/mobile/src/db/schema.web.ts`
- Modify: `apps/mobile/src/sync/pull.ts` (TABLE_UPSERT_SQL + rowToValues)
- Modify: `apps/api/src/routes/sync.ts` (ALLOWED_TABLES, FULL_TABLES, CONFLICT_TARGETS, SCOPED_TABLES + scoped pull)
- Modify: `apps/api/src/lib/syncPolicy.ts` (selectColumnsFor, SENSITIVE_DENY, OPERATION_PERM, applyWritePolicy rules)

**Interfaces:**
- Produces tables (exact columns):
  - `notifications(id uuid pk, user_id uuid, type text, title text, body text, data text, read_at timestamptz null, created_at timestamptz default now(), created_by uuid null, updated_at timestamptz default now())`
  - `approval_requests(id uuid pk, requester_id uuid, kind text, title text, detail text null, status text default 'open', decided_by uuid null, decided_at timestamptz null, decision_note text null, entity_type text null, entity_id uuid null, metadata text null, created_at timestamptz default now(), updated_at timestamptz default now())`
  - `updated_at` on both (pull uses `updated_at > since`).
- Produces `SCOPED_TABLES: Record<string,string>` in sync.ts = `{ notifications: 'user_id' }`, consumed by the two pull queries.

- [ ] **Step 1: API migration.** Create `032_notifications_and_approvals.sql`:
```sql
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data TEXT,
  read_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON notifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS approval_requests (
  id UUID PRIMARY KEY,
  requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'manual',
  title TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  decided_by UUID,
  decided_at TIMESTAMPTZ,
  decision_note TEXT,
  entity_type TEXT,
  entity_id UUID,
  metadata TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS approval_requests_status_idx ON approval_requests (status, updated_at DESC);
```
- [ ] **Step 2: Mobile migration 025.** Mirror both tables in `025_notifications_and_approvals.ts` following the exact shape of `024_telemetry_buffer.ts` (SQLite types: TEXT for uuid/timestamptz, no `REFERENCES`). Export the migration object.
- [ ] **Step 3: Register migration in BOTH schema files.** Add the 025 import + array entry to `apps/mobile/src/db/schema.ts` AND `apps/mobile/src/db/schema.web.ts` (they have separate arrays — a missing registration = "no column named X" on web). Verify by grepping both files list `025`.
- [ ] **Step 4: Pull parity (mobile `pull.ts`).** Add `TABLE_UPSERT_SQL` entries + `rowToValues` mappers for both tables. Assert **column count == placeholder count** for each (notifications = 10 cols; approval_requests = 15 cols). Follow the `repairs` entry as the template.
- [ ] **Step 5: Register in sync.ts.** Add `'notifications'` and `'approval_requests'` to `ALLOWED_TABLES` (set, ~line 26) and `FULL_TABLES` (array, ~line 70). `CONFLICT_TARGETS` default `'id'` is correct for both — no entry needed. Add near `CONFLICT_TARGETS`:
```ts
// Tables whose pull is scoped to the authenticated caller (private per-user data).
const SCOPED_TABLES: Record<string, string> = { notifications: 'user_id' };
```
- [ ] **Step 6: Scoped pull.** In the two pull SELECTs (full ~307, incremental ~331) inject the scope. Full:
```ts
const scopeCol = SCOPED_TABLES[table];
const scopeSql = scopeCol ? ` WHERE ${scopeCol} = $3` : '';
const { rows } = await fastify.pg.query(
  `SELECT ${selectColumnsFor(table, canViewFinancial)} FROM ${table}${scopeSql} ORDER BY 1 LIMIT $1 OFFSET $2`,
  scopeCol ? [limit, offset, callerUserId] : [limit, offset]);
```
Incremental (already has `WHERE ${dateCol} > $1`): append `AND ${scopeCol} = $2` + param when scoped. Use the authenticated caller id (same source as elsewhere in the handler).
- [ ] **Step 7: syncPolicy — column selection.** Extend `selectColumnsFor` (syncPolicy.ts ~238) so both tables return their full column list (no financial gating needed; return all columns). Follow the existing per-table pattern.
- [ ] **Step 8: syncPolicy — write policy.** 
  - `SENSITIVE_DENY['notifications'] = new Set([...all columns except 'read_at','id','user_id'])` so a client UPDATE can only touch `read_at`. Add an `applyWritePolicy` rule: `notifications` op must be UPDATE (reject INSERT/DELETE from clients) and the row must match `user_id === callerUserId` (add to the users-style target guard in sync.ts, Step 9).
  - `approval_requests`: `OPERATION_PERM['approval_requests'] = { INSERT: null, UPDATE: null, DELETE: 'DENY' }` (INSERT/UPDATE allowed to authed users; deciding is guarded in sync.ts hook, Task 6). Force `requester_id = callerUserId` on INSERT via `ATTRIBUTION_COLUMNS['approval_requests'] = ['requester_id']` (confirm ATTRIBUTION_COLUMNS semantics at line 127 and match).
- [ ] **Step 9: sync.ts target guards.** For `notifications` UPDATE: before `applyWritePolicy`, reject if `payload.user_id` present and `!== callerUserId`, and reject non-UPDATE ops. (Approval decision guard is Task 6.)
- [ ] **Step 10: Verify.** `cd apps/api && npx tsc --noEmit && npm test` (green); `cd apps/mobile && npx tsc --noEmit` (green). Manually count placeholders in the two new `TABLE_UPSERT_SQL` strings == column arrays.
- [ ] **Step 11: Commit** `feat(sync): notifications + approval_requests tables (migration 032/025, scoped pull, write policy)`.

---

## Task 2: `deliver()` funnel + `resolveRecipients()` + trigger refactor

**Files:**
- Modify: `apps/api/src/lib/notifications.ts`
- Modify: `apps/api/src/lib/notifications.test.ts`
- Modify: `apps/api/src/routes/sync.ts` (assignment hook → deliver)
- Modify: `apps/api/src/lib/notificationTimer.ts` (checkout-idle → deliver)

**Interfaces:**
- Consumes: `sendPush`, `claimEvent`, `releaseEvent`, `resolveRoleRecipients`, `resolveTeamManagers` (existing in notifications.ts); `crypto.randomUUID` for inbox row ids.
- Produces:
  - `deliver(pg, userIds: string[], p: { type: string; title: string; body: string; data?: Record<string, unknown>; createdBy?: string }): Promise<void>` — inserts one `notifications` row per userId (dedup userIds), then `sendPush(pg, userIds, {title,body,data})`. Never throws.
  - `resolveRecipients(pg, channel: 'assignment'|'low_stock'|'checkout_idle'|'approvals', ctx: { userId?: string }): Promise<string[]>` — union of configured (roles/teams/users from `app_config` `notify_route_<channel>`) + the channel's intrinsic recipients; deduped, active-only.
  - `dedupKeys.approval(id)` = `approval:req:<id>`; `dedupKeys.apprDecision(id,status)` = `approval:dec:<id>:<status>`.

- [ ] **Step 1: Failing test — `deliver` writes N rows + one push.** In `notifications.test.ts`, mock `pg` capturing INSERTs; stub `sendPush` (spy). Assert `deliver(pg,['u1','u2'],{type:'broadcast',title:'t',body:'b'})` runs 2 `INSERT INTO notifications` and calls sendPush once with `['u1','u2']`; duplicate ids deduped to one row each.
- [ ] **Step 2: Run — fails** (`deliver` not defined).
- [ ] **Step 3: Implement `deliver`** in notifications.ts:
```ts
import { randomUUID } from 'node:crypto';
export async function deliver(pg: Pg, userIds: string[], p: { type: string; title: string; body: string; data?: Record<string, unknown>; createdBy?: string }): Promise<void> {
  try {
    const ids = [...new Set(userIds)].filter(Boolean);
    if (!ids.length) return;
    const dataJson = p.data ? JSON.stringify(p.data) : null;
    for (const uid of ids) {
      await pg.query(
        `INSERT INTO notifications (id, user_id, type, title, body, data, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), uid, p.type, p.title, p.body, dataJson, p.createdBy ?? null]);
    }
    await sendPush(pg, ids, { title: p.title, body: p.body, data: p.data });
  } catch { /* never disrupt callers */ }
}
```
- [ ] **Step 4: Run — passes.**
- [ ] **Step 5: Failing test — `resolveRecipients` merge.** Mock `app_config` row `notify_route_low_stock = {"roles":["office_manager"],"teams":[],"users":["u9"]}`; assert result = union of role members + `u9` + intrinsic low_stock roles (`full_admin`,`franchise_manager`), deduped. Assert empty/unset config → intrinsic defaults only. Assert `assignment` channel intrinsic = `ctx.userId` (assignee) always included.
- [ ] **Step 6: Run — fails.**
- [ ] **Step 7: Implement `resolveRecipients`:**
```ts
const INTRINSIC: Record<string, (pg: Pg, ctx: { userId?: string }) => Promise<string[]>> = {
  assignment:   async (_pg, ctx) => ctx.userId ? [ctx.userId] : [],
  low_stock:    async (pg) => resolveRoleRecipients(pg, ['full_admin', 'franchise_manager']),
  checkout_idle:async (pg, ctx) => ctx.userId ? resolveTeamManagers(pg, ctx.userId) : [],
  approvals:    async (pg, ctx) => ctx.userId ? resolveTeamManagers(pg, ctx.userId) : [],
};
export async function resolveRecipients(pg: Pg, channel: keyof typeof INTRINSIC, ctx: { userId?: string } = {}): Promise<string[]> {
  const intrinsic = await INTRINSIC[channel](pg, ctx);
  let configured: string[] = [];
  try {
    const { rows } = await pg.query(`SELECT value FROM app_config WHERE key = $1`, [`notify_route_${channel}`]);
    const raw = rows[0]?.value as string | undefined;
    if (raw) {
      const cfg = JSON.parse(raw) as { roles?: string[]; teams?: string[]; users?: string[] };
      const fromRoles = cfg.roles?.length ? await resolveRoleRecipients(pg, cfg.roles) : [];
      const fromTeams = cfg.teams?.length
        ? (await pg.query(`SELECT DISTINCT tm.user_id FROM team_members tm JOIN users u ON u.id = tm.user_id AND u.active = TRUE WHERE tm.team_id = ANY($1)`, [cfg.teams])).rows.map(r => r.user_id as string)
        : [];
      configured = [...fromRoles, ...fromTeams, ...(cfg.users ?? [])];
    }
  } catch { /* bad config → intrinsic only */ }
  // approvals: approver defaults, fall back to org managers when the requester has no team manager.
  if (channel === 'approvals' && intrinsic.length === 0 && configured.length === 0) {
    configured = await resolveRoleRecipients(pg, ['full_admin', 'franchise_manager']);
  }
  return [...new Set([...intrinsic, ...configured])].filter(Boolean);
}
```
- [ ] **Step 8: Add dedup keys** to the `dedupKeys` object: `approval: (id) => \`approval:req:${id}\``, `apprDecision: (id, status) => \`approval:dec:${id}:${status}\``.
- [ ] **Step 9: Run resolver tests — pass.**
- [ ] **Step 10: Refactor `notifyLowStock`** to use `deliver` + `resolveRecipients(pg,'low_stock')` instead of `resolveRoleRecipients` + `sendPush`. Keep the arm/re-arm `claimEvent`/`releaseEvent` logic. Update its existing test.
- [ ] **Step 11: Refactor the assignment hook** (sync.ts ~211-219): replace the `sendPush(...)` call with `await deliver(pg, await resolveRecipients(pg,'assignment',{userId: assignee}), { type:'assignment', title:'New assignment', body:'You have been assigned a repair.', data:{ screen:'repairs/[id]', id: repairId } })`.
- [ ] **Step 12: Refactor checkout-idle** in `notificationTimer.ts`: its `sendPush` to team managers becomes `deliver(pg, await resolveRecipients(pg,'checkout_idle',{userId}), { type:'checkout_idle', title:'Checkout complete', body:`${name} finished checking out — ${count} items`, data:{ screen:'notifications' } })`. Preserve session dedup.
- [ ] **Step 13: Verify** `cd apps/api && npx tsc --noEmit && npm test` green.
- [ ] **Step 14: Commit** `feat(notify): deliver() inbox funnel + resolveRecipients + refactor triggers`.

---

## Task 3 (#3): Routing-rules config + admin settings UI  *(parallel wave)*

**Files:**
- Modify: `apps/mobile/app/(app)/(admin)/settings.tsx`
- Create: `apps/mobile/src/components/NotificationRoutingEditor.tsx`
- Modify/confirm: `apps/mobile/src/db/queries/appConfig.ts` (synced-config getter/setter used by settings.tsx)

**Interfaces:**
- Consumes: existing synced `app_config` write path used by settings.tsx (find how `notify_enabled`/`notify_poll_interval_min` are read/written there and reuse it verbatim). Server resolver (Task 2) reads `notify_route_<channel>` JSON.
- Produces: settings screen writes `notify_route_assignment|low_stock|checkout_idle|approvals` as JSON `{roles,teams,users}` and `approval_threshold_qty` as a numeric string.

- [ ] **Step 1:** Read `settings.tsx` to learn the exact synced-config read/write helper it already uses for `notify_*` keys. Reuse that helper — do NOT invent a new config path.
- [ ] **Step 2:** Build `NotificationRoutingEditor.tsx`: for each of the 4 channels, a labeled block with multi-select chips for **roles** (from `ROLE_DISPLAY_NAMES`), **teams** (from local `teams` query), **users** (from local `users` query, via `SearchablePicker`). Serializes to `{roles:[],teams:[],users:[]}`. Assignment block notes "extra cc — assignee always notified."
- [ ] **Step 3:** Add a "Notification routing" section to `settings.tsx` (inside the existing `system_settings` gate) rendering the editor, wired to the config helper. Add the `approval_threshold_qty` numeric input here too (label: "Require approval for movements ≥ (blank = off)").
- [ ] **Step 4:** Verify `cd apps/mobile && npx tsc --noEmit` green. Manual: values persist + appear in outbox as `app_config` UPDATEs.
- [ ] **Step 5: Commit** `feat(notify): admin routing-rules editor + approval threshold config (#3)`.

---

## Task 4 (#4): `send_notifications` permission + broadcast route + composer  *(parallel wave)*

**Files:**
- Modify: `apps/mobile/src/constants/roles.ts`
- Modify: `apps/api/src/lib/permissions.ts`
- Create: `apps/api/src/routes/notifications.ts`, `apps/api/src/routes/notifications.test.ts`
- Modify: `apps/api/src/index.ts` (register `/notifications`)
- Create: `apps/mobile/app/(app)/(admin)/broadcast.tsx`

**Interfaces:**
- Consumes: `deliver`, `resolveRoleRecipients` (Task 2 / existing); `requirePermission` (permissions.ts); `overRateLimit` (rateLimit).
- Produces: `POST /notifications/broadcast` body `{ audience: { roles?: string[]; teams?: string[]; everyone?: boolean }; title: string; body: string }` → resolves audience, excludes sender, `deliver(...,{type:'broadcast'})`.

- [ ] **Step 1: Permission — mobile.** Add `'send_notifications'` to the `Permission` union in `roles.ts` and to **all four** tier maps: tier4 `true`, tier3 `true`, tier2 `false`, tier1 `false`. (tsc will error on any tier map missing the key — that's the guard.)
- [ ] **Step 2: Permission — API mirror.** Add `send_notifications` wherever `permissions.ts` enumerates keys/defaults so `userHasPermission`/`requirePermission('send_notifications')` resolves. Match the existing mirror pattern.
- [ ] **Step 3: Failing test — audience resolution.** In `notifications.test.ts`, unit-test a pure `resolveAudience(pg, audience, senderId)` helper (export it from routes/notifications.ts): `everyone:true` → all active users minus sender; roles+teams union deduped; empty audience → `[]` (route rejects). Mock `pg`.
- [ ] **Step 4: Run — fails.**
- [ ] **Step 5: Implement route + helper** `routes/notifications.ts`:
```ts
import { FastifyPluginAsync } from 'fastify';
import { overRateLimit } from '../lib/rateLimit';
import { deliver, resolveRoleRecipients } from '../lib/notifications';
export async function resolveAudience(pg, audience, senderId): Promise<string[]> {
  const ids = new Set<string>();
  if (audience.everyone) {
    (await pg.query(`SELECT id FROM users WHERE active = TRUE`, [])).rows.forEach(r => ids.add(r.id));
  } else {
    if (audience.roles?.length) (await resolveRoleRecipients(pg, audience.roles)).forEach(i => ids.add(i));
    if (audience.teams?.length) (await pg.query(`SELECT DISTINCT tm.user_id FROM team_members tm JOIN users u ON u.id=tm.user_id AND u.active=TRUE WHERE tm.team_id = ANY($1)`, [audience.teams])).rows.forEach(r => ids.add(r.user_id));
  }
  ids.delete(senderId);
  return [...ids];
}
const routes: FastifyPluginAsync = async (fastify) => {
  const gate = { preHandler: [(fastify as any).authenticate, (fastify as any).requirePermission?.('send_notifications')].filter(Boolean) };
  fastify.post('/broadcast', { ...gate, schema: { body: { type:'object', required:['audience','title','body'],
    properties: { audience:{type:'object'}, title:{type:'string',maxLength:120}, body:{type:'string',maxLength:1000} } } } },
    async (request, reply) => {
      const senderId = (request.user as {sub:string}).sub;
      if (overRateLimit(`broadcast:${senderId}`)) return reply.status(429).send({ error:'rate' });
      const to = await resolveAudience(fastify.pg, (request.body as any).audience, senderId);
      if (!to.length) return reply.status(400).send({ error:'empty_audience' });
      await deliver(fastify.pg, to, { type:'broadcast', title:(request.body as any).title, body:(request.body as any).body, data:{ screen:'notifications' }, createdBy: senderId });
      return { ok:true, recipients: to.length };
    });
};
export default routes;
```
Confirm how permission gating is applied on other routes (grep `requirePermission` usage) and match it — if there's no `requirePermission` decorator, gate inside the handler by loading the caller's role/overrides and calling `userHasPermission`.
- [ ] **Step 6: Run — passes.**
- [ ] **Step 7: Register** in `index.ts`: `app.register(notificationsRoutes, { prefix: '/notifications' })` next to the `/push` registration.
- [ ] **Step 8: Composer screen** `broadcast.tsx` (gate render on `usePermission('send_notifications')`): audience multi-select (roles chips / teams chips / "Everyone" toggle), title + body inputs, live recipient-count (local estimate), Send → `POST /notifications/broadcast` via the app's authed fetch helper, success/confirm toast. Add an entry point from the admin menu/settings.
- [ ] **Step 9: Verify** api tsc+tests green; mobile tsc green.
- [ ] **Step 10: Commit** `feat(notify): send_notifications permission + broadcast route + composer (#4)`.

---

## Task 5: In-app inbox client (list + unread badge + queries + deep-link)  *(parallel wave)*

**Files:**
- Create: `apps/mobile/src/db/queries/notifications.ts`
- Create: `apps/mobile/app/(app)/(notifications)/index.tsx`, `apps/mobile/app/(app)/(notifications)/_layout.tsx`
- Create: `apps/mobile/src/components/NotificationBell.tsx`
- Modify: the app shell/header where other nav lives (add the bell) + confirm the existing push-response observer routes `data.screen === 'notifications'`.

**Interfaces:**
- Consumes: local `notifications` table (Task 1 mobile migration); `appendOutbox` for `read_at` UPDATE; `useDataVersion()` (existing reactive store).
- Produces:
  - `listNotifications(): Row[]` (newest first), `countUnread(): number`, `markRead(id)`, `markAllRead()` — all in `db/queries/notifications.ts`. `markRead` writes `read_at` via outbox `UPDATE notifications`.

- [ ] **Step 1:** `db/queries/notifications.ts`: `listNotifications()` → `SELECT * FROM notifications ORDER BY created_at DESC LIMIT 200`; `countUnread()` → `SELECT COUNT(*) WHERE read_at IS NULL`; `markRead(id)` → local `UPDATE notifications SET read_at=? WHERE id=?` + `appendOutbox('UPDATE','notifications',{id, read_at})`; `markAllRead()` loops unread ids. Match the sync/query conventions of `db/queries/repairs.ts`.
- [ ] **Step 2:** `(notifications)/index.tsx`: FlatList of rows; unread rows emphasized; each row shows title/body/relative-time + a type icon; tap → `markRead(id)` then `router.push` to `data.screen`/`id` when present (else stay). Pull-to-refresh triggers a sync pull; subscribe to `useDataVersion()` so it refreshes after sync. Approval rows leave room for inline actions (Task 7 injects them — expose a render slot keyed by `type==='approval_request' && status open`; Task 7 fills it).
- [ ] **Step 3:** `NotificationBell.tsx`: bell icon + unread count badge from `countUnread()`, subscribes to `useDataVersion()`; press → navigate to `(notifications)`. Place in the app header/shell alongside existing icons.
- [ ] **Step 4:** Confirm the #1 notification-response observer (in `app/(app)/_layout.tsx`) routes on `data.screen`; ensure `'notifications'` resolves to the inbox route. Add the route to the router group if needed.
- [ ] **Step 5:** Verify `cd apps/mobile && npx tsc --noEmit` green. Manual: a seeded inbox row renders; marking read clears the badge; survives a sync round-trip.
- [ ] **Step 6: Commit** `feat(notify): in-app inbox list + unread bell + queries (foundation client)`.

---

## Task 6 (#5 server): approval sync hooks + threshold auto-flag  *(parallel wave)*

**Files:**
- Modify: `apps/api/src/routes/sync.ts` (approval INSERT/UPDATE hooks + threshold)
- Modify: `apps/api/src/routes/sync.test.ts` (or add to notifications.test.ts) — status-transition + threshold tests

**Interfaces:**
- Consumes: `deliver`, `resolveRecipients` (Task 2); `claimEvent`, `dedupKeys.approval`, `dedupKeys.apprDecision` (Task 2); `getNotifyConfig`/a new `approval_threshold_qty` read.
- Produces: server side effects only (inbox rows + push). No new exports required by later tasks except the client relies on the decision notification arriving.

- [ ] **Step 1: Failing test — approval INSERT notifies approvers once.** Simulate an `approval_requests` INSERT reaching the push loop; assert `deliver` called with approvers from `resolveRecipients(pg,'approvals',{userId:requester})`, `type:'approval_request'`, and `claimEvent(dedupKeys.approval(id))` gates a retry (second identical INSERT → no second deliver).
- [ ] **Step 2: Failing test — decision notifies requester only on real transition.** Pre-row `status:'open'`; UPDATE to `approved` → `deliver` to `[requester_id]` `type:'approval_decision'`, deduped by `apprDecision(id,'approved')`. UPDATE that doesn't change status → no deliver. Non-approver caller UPDATE of status → rejected (guard).
- [ ] **Step 3: Failing test — threshold auto-flag.** With `approval_threshold_qty='10'`, a `stock_by_location` checkout/transfer op `|qty|>=10` in the batch → server inserts a `kind:'threshold_checkout'` `approval_requests` row + notifies approvers, deduped per source op id. `|qty|<10` or blank threshold → nothing.
- [ ] **Step 4: Run — all fail.**
- [ ] **Step 5: Implement INSERT hook.** In sync.ts INSERT path (after `applyWritePolicy`, ~229), when `table_name==='approval_requests'`: wrap in try/catch; `if (await claimEvent(pg, dedupKeys.approval(payload.id)))` then resolve approvers via `resolveRecipients(pg,'approvals',{userId: payload.requester_id})` and `deliver(...,{type:'approval_request', title:'Approval requested', body: payload.title, data:{screen:'notifications', id: payload.id}, createdBy: payload.requester_id})`.
- [ ] **Step 6: Implement UPDATE guard + decision hook.** In sync.ts UPDATE path: capture pre-row `status`,`requester_id` (like the assignee pre-read). **Guard:** if the UPDATE changes `status`/`decided_*`, require the caller to be in `resolveRecipients(pg,'approvals',{userId:pre.requester_id})` OR have `manage_teams`/`full_admin`; a requester may only set `status='cancelled'` on their own row — else reject the entry (push conflict). On a real `open`→`approved|rejected` transition: `if (await claimEvent(pg, dedupKeys.apprDecision(id,newStatus)))` then `deliver(pg,[pre.requester_id], {type:'approval_decision', title:`Request ${newStatus}`, body: payload.decision_note || payload.title || '', data:{screen:'notifications', id}})`.
- [ ] **Step 7: Implement threshold.** After the push batch commits (near the `notifyLowStock` loop ~527), collect checkout/transfer ops on `stock_by_location` with `|qty|>=threshold` (read `approval_threshold_qty` from app_config; blank/0 → skip). For each, dedup on the source outbox op id (`claimEvent('approval:auto:'+opId)`), INSERT an `approval_requests` row (`kind:'threshold_checkout'`, title referencing item + qty, `metadata` JSON with op id/location), then the INSERT hook path (or directly) notifies approvers. Keep it in the same fire-and-forget post-batch block; try/catch.
- [ ] **Step 8: Run — pass.**
- [ ] **Step 9: Verify** `cd apps/api && npx tsc --noEmit && npm test` green.
- [ ] **Step 10: Commit** `feat(notify): approval request/decision sync hooks + threshold auto-flag (#5 server)`.

---

## Task 7 (#5 client): request-approval UI + inbox inline actions  *(after Tasks 5 & 6)*

**Files:**
- Create: `apps/mobile/src/components/RequestApprovalSheet.tsx`
- Modify: `apps/mobile/src/db/queries/notifications.ts` (add `createApprovalRequest`, `decideApproval`, `listOpenApprovals`)
- Modify: `apps/mobile/app/(app)/(notifications)/index.tsx` (inline Approve/Reject for open approval items)
- Modify: relevant detail screens for the manual entry point — `app/(app)/(equipment)/[id].tsx`, `app/(app)/(inventory)/[id].tsx`, `app/(app)/(jobs)/[id].tsx` (add a "Request approval" affordance)

**Interfaces:**
- Consumes: local `approval_requests` + `notifications` tables; `appendOutbox`; the inbox render slot from Task 5.
- Produces: `createApprovalRequest({kind,title,detail?,entityType?,entityId?,metadata?})` → INSERT `approval_requests` (status 'open', requester_id = current user) + outbox INSERT; `decideApproval(id, 'approved'|'rejected', note?)` → local UPDATE + outbox UPDATE (status, decided_by=me, decided_at=now, decision_note).

- [ ] **Step 1:** Add `createApprovalRequest`, `decideApproval`, `listOpenApprovals` to `db/queries/notifications.ts`. `createApprovalRequest` generates a uuid, writes local row + `appendOutbox('INSERT','approval_requests', row)`. `decideApproval` writes local UPDATE + `appendOutbox('UPDATE','approval_requests',{id,status,decided_by,decided_at,decision_note})`.
- [ ] **Step 2:** `RequestApprovalSheet.tsx`: a modal with title + detail inputs, optional entity ref (prefilled when opened from a detail screen), Submit → `createApprovalRequest`. Success toast.
- [ ] **Step 3:** Wire the inbox render slot (Task 5): for `type==='approval_request'` items whose linked `approval_requests.status==='open'` (join via `data.id`), render **Approve** / **Reject** buttons (+ optional note) calling `decideApproval`. After deciding, the row updates locally and the decision syncs; approver sees it resolve.
- [ ] **Step 4:** Add a "Request approval" button to the equipment-unit, item, and job detail screens that opens `RequestApprovalSheet` with the entity prefilled.
- [ ] **Step 5:** Verify `cd apps/mobile && npx tsc --noEmit` green. Manual end-to-end: request → (sync) approver inbox shows it → approve → (sync) requester inbox shows decision.
- [ ] **Step 6: Commit** `feat(notify): request-approval UI + inbox approve/reject actions (#5 client)`.

---

## Self-Review (coverage against spec)
- Inbox foundation → Tasks 1 (tables/scoped pull) + 2 (`deliver`) + 5 (client). ✓
- #3 routing rules → resolver in Task 2 (`resolveRecipients` reads `notify_route_*`) + UI in Task 3. ✓
- #4 broadcast + `send_notifications` → Task 4. ✓
- #5 approvals (tables, hooks, threshold, request UI, inline actions) → Tasks 1 (table) + 6 (server) + 7 (client). ✓
- Trigger refactor (assignment/low-stock/checkout-idle → `deliver`) → Task 2. ✓
- Sync parity / migration checklist → Task 1 Steps 3–10. ✓
- Non-blocking approvals (offline-safe) → Task 6 (movement applies; request is a review flag). ✓
- Privacy (payload templates, no PII) → templates in Tasks 2/4/6; broadcast body is sender text. ✓
- Testing (`node:test`) → resolver/deliver/broadcast/approval/threshold tests in Tasks 2/4/6. ✓

**Parallelism (UltraMode):** Task 1 → Task 2 (serial foundation). Then Tasks 3, 4, 5, 6 in parallel (disjoint files: 3=settings.tsx+editor; 4=roles/permissions/routes/index/broadcast; 5=inbox client; 6=sync.ts hooks). Then Task 7 (edits Task 5's inbox file + uses Task 6's tables). Each task ends green + committed; a reviewer gates each.
