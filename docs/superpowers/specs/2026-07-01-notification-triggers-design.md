# Spec — Notification event triggers (sub-project #2)

## Context
Sub-project **#1 (push delivery foundation)** shipped `sendPush(pg, userIds, payload)`
+ `device_push_tokens` + `/push/*`, but nothing calls `sendPush` yet. This spec
(#2) wires the first real events to it. Later sub-projects: **#3** admin-configurable
routing rules UI, **#4** broadcast composer + `send_notifications` permission, **#5**
approvals workflow.

**Trigger set (3):** repair/job **assignment** and **low-stock** (both write-triggered),
and the **checkout-idle timer** (time-based). Repair-overdue/SLA is explicitly **out**
— repairs don't need an overdue alert.

## Architecture — two detection paths, one sender
Both funnel into the existing `sendPush`:
1. **Write-triggered** — inside `/sync/push`, right after a write applies (no timer):
   **assignment** + **low-stock**.
2. **Time-based** — a single **in-process `setInterval`** in the API (the API is one
   always-on container, so no multi-instance coordination): the **checkout-idle**
   check. The API has no scheduler today; this adds one, self-contained.

## Recipients (hardcoded sensible defaults; #3 makes them editable)
| Event | Recipients |
|---|---|
| **Assignment** | the assignee (specific user) |
| **Low-stock** | org managers — role set `full_admin` + `franchise_manager` (stock isn't team-scoped) |
| **Checkout-idle** | the crew member's **team manager(s)** — `team_members.is_manager` across every team they're on, deduped |

"Production manager" = the `is_manager` of the crew member's team (there is no
distinct `production_manager` role).

## The three triggers
### 1. Assignment (write-triggered)
In `/sync/push`, when a `repairs` UPDATE sets/changes `assignee_id` (and `jobs` if it
has an assignee column — confirm during planning; if not, repairs only), push to the
new assignee: *"You've been assigned a repair."* No item/customer content in the
payload — ids + a fixed message only. Dedup key `assign:repair:<id>:<assignee>`.

### 2. Low-stock (write-triggered)
On a stock-decreasing ADJUST, after the new `stock_by_location` total is written, if
the item's total on-hand **crosses to ≤ `inventory_items.min_qty_alert`**, push to the
manager role set: *"Low stock: <item name> is at or below its alert level."* (item
*name* is not PII). Dedup key `lowstock:item:<id>`; **re-arm** (delete the key) once
total climbs back above `min_qty_alert`, so a later dip alerts again but a hovering
level doesn't spam.

### 3. Checkout-idle timer (time-based)
A "session" is a run of one crew member's inventory checkouts (equipment / products /
any check-out) where consecutive checkouts are < the idle gap apart. When the trailing
gap since their **last checkout reaches `notify_checkout_idle_min`** (default 15) with
no further checkout, the session is "complete": push to their team manager(s) **once**,
count-only — *"<name> finished checking out — N items"* (no item list / no PII).
- Detection each tick: from `activity_log` checkout actions, find users whose most-
  recent checkout is now older than the idle gap and not yet session-closed; count the
  checkouts back to the session start (first checkout after a ≥ idle-gap gap).
- Dedup key `session:user:<id>:<last_checkout_ts>` (unique per session — the next
  session ends at a different timestamp).

## New data
- **`notification_dedup`** — server-only table (API migration **031**; **not** in
  `ALLOWED_TABLES`/`FULL_TABLES`/`pull.ts`): `event_key TEXT PRIMARY KEY, created_at
  TIMESTAMPTZ NOT NULL DEFAULT NOW()`. A trigger fires only when its key is absent —
  server-side mirror of the `localAlerts` dedup. Low-stock deletes its key to re-arm.
- **`app_config` keys** (synced, admin-editable, `system_settings`-gated):
  - `notify_enabled` (default `'1'`) — master kill-switch for all server triggers.
  - `notify_poll_interval_min` (default `'5'`) — timer cadence.
  - `notify_checkout_idle_min` (default `'15'`) — the idle gap.

## Server timer
`startNotificationTimer()` in `apps/api/src/index.ts` after `listen`. Each tick:
re-reads `notify_enabled` + `notify_poll_interval_min` from `app_config` (so admin
edits apply without a restart — reschedules if the interval changed), and if enabled
runs the checkout-idle check. The whole tick is wrapped in try/catch — a trigger
failure logs and never crashes the timer or the API.

## Settings UI
Two numeric inputs (idle gap, poll interval) + the enable toggle in
`apps/mobile/app/(app)/(admin)/settings.tsx` (already `system_settings`-gated),
writing the three `app_config` keys through the existing synced-config path.

## Privacy / safety
Payloads are fixed messages + ids + item *names* + counts — never customer content,
field values, or item lists. All sends go through `sendPush`, which is already
fire-and-forget and disables dead tokens. Every trigger is deduped so a device can't
be spammed.

## Testing (`node:test`, mock `pg`)
Pure logic: recipient resolution (team managers across multiple teams, deduped),
dedup-key builders, low-stock crossing (arm + re-arm), and checkout-idle/session
detection (session boundary + count). The `/sync/push` hooks and the timer wiring are
verified by inspection + a manual on-device pass.

## Out of scope
Repair-overdue/SLA (dropped); #3 admin routing-rules UI; #4 broadcast + permission;
#5 approvals; per-item return timers (interpretation B); iOS specifics (push
foundation is Android-first).
