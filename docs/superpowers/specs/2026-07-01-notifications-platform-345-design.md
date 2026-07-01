# Spec — Notifications platform #3 / #4 / #5

## Context
The notifications platform shipped **#1** (push foundation: `sendPush`, `device_push_tokens`,
`/push/*`) and **#2** (event triggers: assignment, low-stock, checkout-idle — all funnelling
through `sendPush`). This spec covers the last three sub-projects:

- **#3** admin-configurable notification **routing rules** (make #2's hardcoded recipients editable)
- **#4** **broadcast composer** + a new `send_notifications` permission
- **#5** **approvals workflow**

**Scope decisions (chosen as the recommended options while the user was AFK — CONFIRM on review):**
1. **Add a persistent, synced in-app notification inbox** as the shared foundation (vs OS-push-only).
2. **#5 approvals = generic primitive + threshold trigger**, implemented **non-blocking / review-style**
   (see "Why non-blocking").
3. **#4 broadcast targets roles + teams + everyone** (multi-select audience).
4. **#3 = full per-trigger recipient editor** (role-sets / teams / specific users; current hardcoded
   values become the seed/fallback).

## Why a shared inbox first
Today notifications are ephemeral: OS push + on-device local alerts, no in-app record. Broadcasts and
approval requests must not vanish if a push is missed, and approvals must be **actionable in-app**. So
the foundation is a per-user **`notifications` inbox** that every trigger, broadcast, and approval event
writes to; push becomes a *nudge* pointing at the inbox. This unifies delivery behind one funnel.

## Architecture — one delivery funnel
`apps/api/src/lib/notifications.ts` gains a single primitive that all producers call:

```
deliver(pg, userIds, { type, title, body, data? })
  → INSERT one notifications row per recipient (the durable inbox item)
  → sendPush(pg, userIds, {title, body, data})   // fire-and-forget nudge (unchanged transport)
```

`sendPush` (lib/push) is untouched — it stays the push transport. The three #2 triggers
(`notifyLowStock`, assignment hook in sync.ts, checkout-idle in notificationTimer) are refactored to
call `deliver()` instead of `sendPush()` directly, so their events also become durable inbox items.

## Data model

### New synced table `notifications` (per-user inbox) — API migration 032, mobile 025
`id UUID PK, user_id UUID (recipient) REFERENCES users(id) ON DELETE CASCADE, type TEXT, title TEXT,
body TEXT, data TEXT (JSON: {screen,id,...} routing), read_at TIMESTAMPTZ NULL, created_at TIMESTAMPTZ
NOT NULL DEFAULT NOW(), created_by UUID NULL`. Index `(user_id, created_at DESC)`.
`type ∈ {assignment, low_stock, checkout_idle, broadcast, approval_request, approval_decision}`.

- **Per-user pull scoping (new, contained pattern):** a `SCOPED_TABLES: Record<string,string> =
  { notifications: 'user_id' }` map in `sync.ts`. Both pull queries (full `:307`, incremental `:331`)
  append `AND <col> = $caller` (or `WHERE` when none present) when the table is scoped, so a device only
  downloads its logged-in user's inbox. This is the only per-user-scoped table; everything else stays
  org-wide as today.
- **Client writes:** the app never inserts `notifications` (server-generated). The client may only
  **UPDATE `read_at`** on its own rows, via the existing outbox path. `applyWritePolicy` restricts
  `notifications` to op=UPDATE, column allow-list `{read_at}` only, and `user_id = callerUserId`
  (mass-assignment + cross-user guard). INSERT/DELETE from clients are rejected.

### New synced table `approval_requests` (workflow records) — API migration 032, mobile 025
Org-wide (like `repairs`/`activity_log` — low volume, managers see the queue):
`id UUID PK, requester_id UUID, kind TEXT, title TEXT, detail TEXT NULL, status TEXT NOT NULL DEFAULT
'open', decided_by UUID NULL, decided_at TIMESTAMPTZ NULL, decision_note TEXT NULL,
entity_type TEXT NULL, entity_id UUID NULL, metadata TEXT NULL (JSON), created_at/updated_at TIMESTAMPTZ`.
`status ∈ {open, approved, rejected, cancelled}`. `kind ∈ {manual, threshold_checkout, threshold_transfer}`.

- **Two-way synced** (in `ALLOWED_TABLES`/`FULL_TABLES`/`pull.ts` parity — full column list, count ==
  placeholders per `SYNC-MIGRATION-CHECKLIST.md`). Client creates (INSERT) and decides (UPDATE status).
- **Server hooks in `/sync/push`:** on `approval_requests` INSERT → `deliver()` a `type:approval_request`
  inbox item + push to the **approvers** (resolved via #3 config for the `approvals` channel; default =
  the requester's team managers, else `full_admin`+`franchise_manager`). On UPDATE that moves `status`
  open→approved/rejected → `deliver()` a `type:approval_decision` item + push to the **requester**.
  Change-detection mirrors the assignment hook (read pre-row, act only on real status transitions).
- **Write policy:** requester may INSERT (requester_id forced to caller). Deciding (UPDATE
  status/decided_by/decided_at/decision_note) requires the resolved-approver membership OR
  `manage_teams`/`full_admin`; requester may only UPDATE own row to `cancelled`. Enforced in
  `applyWritePolicy` + a target guard like the users-role guard.

## #3 — Routing rules (config, no new table)
Per-channel recipient config stored as `app_config` JSON values (synced, `system_settings`-gated),
one key per channel: `notify_route_assignment`, `notify_route_low_stock`, `notify_route_checkout_idle`,
`notify_route_approvals`. Value shape: `{"roles":[...],"teams":[...],"users":[...]}`. Empty/unset →
the existing hardcoded default for that channel (assignment→assignee is intrinsic and NOT rerouted;
its config only adds *extra* cc recipients).

- **Resolver:** `resolveRecipients(pg, channel, ctx)` in notifications.ts merges configured
  roles→`resolveRoleRecipients`, teams→members, users (literal), deduped + active-filtered, unioned with
  the channel's intrinsic recipients (assignee for assignment; requester's team managers for approvals).
- **Admin UI:** a "Notification routing" section in the existing `(admin)/settings.tsx` (already
  `system_settings`-gated) — per channel, multi-select chips for roles / teams / users, written through
  the synced-config path. Reuses `SearchablePicker`/chips.

## #4 — Broadcast composer + `send_notifications` permission
- **New permission `send_notifications`** added to: `apps/mobile/src/constants/roles.ts` (the
  `Permission` union + all four tier maps — default: tier-4 true, tier-3 true, tier-1/2 false), and the
  API mirror `apps/api/src/lib/permissions.ts`. (Admins can still per-user override via existing role UI.)
- **Route** `POST /notifications/broadcast` (authed, `requirePermission('send_notifications')`,
  rate-limited, body-validated): `{ audience: {roles?, teams?, everyone?}, title, body }` → resolve
  audience (reuse the #3 resolver, `everyone` = all active users) → `deliver()` (inbox rows + push).
  Sender excluded from own broadcast. Length caps on title/body; audience must be non-empty.
- **Compose screen** `app/(app)/(admin)/broadcast.tsx` (gated on `send_notifications`): audience
  multi-select (roles/teams/everyone), title + body, live recipient count, Send with confirm. Entry
  point from settings/admin menu.

## #5 — Approvals workflow (non-blocking / review-style)
### Why non-blocking
The app is **offline-first**: a checkout is applied locally and queued in the outbox, so an approval
cannot *gate* it without breaking offline use. So approvals are a **review/acknowledgement** flow:
the action proceeds; the request surfaces it for a manager to **approve (acknowledge)** or **reject
(flag for follow-up/reversal)**. This is called out for the user to confirm.

### Flows
- **Manual "Request approval"** — a `RequestApprovalButton`/sheet available on relevant detail screens
  (equipment unit, item, job) writes an `approval_requests` row (`kind:manual`, title, detail,
  entity ref). Approver(s) get an inbox item + push; approve/reject inline from the inbox → requester
  notified.
- **Threshold auto-flag** — `app_config` key `approval_threshold_qty` (default `''`/0 = disabled,
  `system_settings`-gated). When a `stock_by_location` checkout/transfer op whose `|qty|` ≥ threshold
  reaches `/sync/push`, the server creates a `kind:threshold_*` `approval_requests` row (the movement
  already applied) and notifies approvers. Deduped per source op id so a retry doesn't double-file.
- **Inbox actions** — `approval_request` inbox items render inline **Approve / Reject** (with optional
  note) → outbox UPDATE of the `approval_requests` row's status → server notifies requester with the
  decision. `approval_decision` items are informational (tap → the request/entity).

## Client: inbox UI
- **`app/(app)/(notifications)/index.tsx`** — a list of the user's `notifications` (newest first),
  unread emphasis, tap routes via `data.screen`/`id`, approval items show inline actions, pull-to-refresh
  + reactive `useDataVersion()` refresh after sync. Marking read = outbox UPDATE `read_at`.
- **Unread badge** — a small `db/queries/notifications.ts` `countUnread()` feeding a header bell icon
  (in the app shell / dashboard header). Subscribes to `useDataVersion()`.
- **Deep-link on push tap** — the existing notification-response observer (from #1, in `_layout`)
  already routes on `data.screen`; approval/broadcast payloads set `screen: 'notifications'` (or the
  entity screen) so a tapped push lands correctly. No new observer.

## Sync-migration checklist (both new synced tables)
For `notifications` and `approval_requests`: API migration 032 + mobile migration 025 (registered in
**both** `schema.ts` AND `schema.web.ts`); `pull.ts` `TABLE_UPSERT_SQL` + `rowToValues` parity
(column count == placeholders); `sync.ts` `ALLOWED_TABLES`/`FULL_TABLES`/`CONFLICT_TARGETS`, per-table
`OPERATION_PERM`, `selectColumnsFor`, and `applyWritePolicy`/`SENSITIVE_DENY` rules above;
`SCOPED_TABLES` entry for `notifications`. `notification_dedup` (031) is reused for the threshold and
approval-decision dedup keys; add key builders `approval(id)` and `apprDecision(id,status)`.

## Privacy / security
- Inbox rows are per-user, pull-scoped, and client-immutable except `read_at`. No customer content in
  push payloads (unchanged #2 discipline) — titles/bodies are the sender's text (broadcast) or fixed
  templates (triggers/approvals) + ids only.
- `send_notifications` gates broadcast; approvals decisions gated to resolved approvers/`manage_teams`.
- Everything through `deliver()` is deduped where it can repeat (low-stock re-arm unchanged; threshold
  + approval-decision get dedup keys). All server hooks are try/caught — a notification failure never
  breaks sync.

## Testing (`node:test`, mock `pg`)
- `resolveRecipients` (config merge across roles/teams/users, dedup, active-filter, intrinsic union).
- Broadcast audience resolution (`everyone`, role/team union, sender exclusion, empty-audience reject).
- Approval status-transition guard (only real open→decided fires a decision; requester-cancel path;
  non-approver rejected).
- Threshold detection (|qty| ≥ threshold arms; below doesn't; per-op dedup).
- `deliver()` writes N inbox rows + calls sendPush once (mock).
- Mobile: `tsc --noEmit`; pull.ts parity counts asserted.

## Out of scope
- Blocking/gating approvals (offline-incompatible — chosen non-blocking).
- iOS/APNs (foundation is Android-first).
- Notification digests/quiet-hours/email/SMS channels.
- Per-user notification preference opt-outs (only admin-side routing in #3).
- Editing the permission key set at runtime (compile-time union, as today).

## Assumptions to confirm (review gate)
The four scope decisions above (inbox foundation; non-blocking approvals; broadcast audience;
full routing editor) were selected as recommended defaults while the user was away.
