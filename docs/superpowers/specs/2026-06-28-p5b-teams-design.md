# P5 · 5b — Multi-Manager Teams + Cross-Team Activity — Design Spec

*Date: 2026-06-28 · Branch: `feat/p5b-teams` · Program P5, build 2 of 2 (after 5a).*

## Context

Two team/visibility upgrades:
1. **Multi-manager teams.** `teams.manager_id` is a single nullable manager today. Support multiple managers
   per team by flagging members as managers (`team_members.is_manager`), migrating the existing `manager_id`.
2. **Cross-team activity visibility.** A manager can't currently see what their people do. Add a
   "My Team's Activity" view: all activity by the members of teams the manager manages, **across all
   jobs/teams** (per the locked decision), gated by a new `view_team_activity` permission.

### Decisions locked with the user
- **Manager model:** managers are members flagged `is_manager` on `team_members` (roadmap's preferred model);
  migrate the existing single `teams.manager_id` into a flagged member row. Keep the `manager_id` column
  (deprecated/unread) — no destructive drop.
- **Cross-team scope:** "members' activity everywhere" — `activity_log WHERE user_id IN (members of teams I
  manage)`, regardless of which job/team it was for.
- **New permission key `view_team_activity`** (hardcoded in code, default ON for manager-tier roles); it
  auto-appears in the 5a role matrix, so per-role assignment is then runtime-tunable.

## Global Constraints
- Expo SDK 56; op-sqlite binds `string|number|null|ArrayBuffer`. **Migration 015; no native deps.**
- Sync-migration checklist applies (`team_members` is synced). **Notable sync change:** `team_members` switches
  its incremental-pull timestamp from `joined_at` to a new `updated_at` (see Unit 1) because `is_manager` is
  mutable — an append-only `joined_at` would never propagate a promote/demote.
- The 19→20 permission keys + `ROLE_DEFAULTS` are duplicated in mobile `constants/roles.ts` and api
  `lib/permissions.ts` — add `view_team_activity` to BOTH identically.
- TypeScript gate: `npx tsc --noEmit` clean (mobile + api).

## Shared Context Pack
- **teams:** `apps/api/src/db/migrations/001_initial_schema.sql:112-121` (`id,name,type,manager_id,updated_at`);
  mobile `apps/mobile/src/db/migrations/001_initial.ts:79-89` (+`synced_at`). pull.ts teams: `pull.ts:14,30`
  (5 cols).
- **team_members:** api `001_initial_schema.sql:124-131` — composite PK `(team_id,user_id)`,
  `team_permission_overrides JSONB`, `added_by`, `joined_at` (TIMESTAMPTZ); mobile `001_initial.ts:92-101`.
  pull.ts `pull.ts:15,31` (5 cols). Conflict target `team_members: 'team_id, user_id'` (`sync.ts:26`).
  **Incremental pull uses `joined_at`** (`sync.ts:210`).
- **team queries (`apps/mobile/src/db/queries/teams.ts`):** `getAllTeams`, `getTeamById`,
  `getTeamMembers(teamId)` (LEFT JOIN users → adds `user_name`,`user_role`), `upsertTeam`,
  `addTeamMember(teamId,userId,overrides?,addedBy?)` (INSERT OR IGNORE → `{joined_at}|null`),
  `removeTeamMember(teamId,userId)`. `TeamMember` iface `:12-21`.
- **team screens:** `app/(app)/(teams)/index.tsx` (list + create; single manager picker `:43,79`),
  `app/(app)/(teams)/[id].tsx` (detail; manager display `:229-233`, add/remove member `:122-200`,
  member list `:258-281`).
- **activity-log:** `apps/mobile/src/db/queries/log.ts` — `getLogFiltered(filter,limit)` `:189-223`
  (`LogFilter {userId?,action?,sinceISO?,untilISO?}` `:182-187`), `getLogForUser`, `getRecentLog`.
  `activity_log` has `team_id` (nullable) + indexes on `user_id`, `created_at` (api `001:147-164`).
  Server `apps/api/src/routes/logs.ts:21-70` (`GET /logs`, `requirePermission('view_all_logs')`, filters
  user_id/action/before/after/…). Global view `app/(app)/(logs)/index.tsx` (tabs: My Activity / Pending /
  All Activity; All Activity fetches `/logs` server-side `:100-152`).
- **permissions:** keys + ROLE_DEFAULTS mobile `constants/roles.ts:16-35,173-187`, api `lib/permissions.ts`
  (tiers). Resolver: mobile `auth/permissions.ts hasPermission`, server `requirePermission`. (5a made role
  assignment dynamic + added a `full_admin` floor.)
- **Migrations:** current max = **014**; this is **015**.

---

## Architecture (units)

### Unit 1 — Migration 015 + team_members sync switch
**Files:** `apps/api/src/db/migrations/015_team_managers.sql`,
`apps/mobile/src/db/migrations/015_team_managers.ts` (+ register v15 in `schema.ts`),
`apps/api/src/routes/sync.ts`, `apps/mobile/src/sync/pull.ts`.
- api: `ALTER TABLE team_members ADD COLUMN IF NOT EXISTS is_manager BOOLEAN NOT NULL DEFAULT FALSE;`
  `ALTER TABLE team_members ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`
  Backfill `updated_at = joined_at`. **Migrate manager_id:** for each team with a non-null `manager_id`,
  upsert a `team_members(team_id, user_id=manager_id, is_manager=true)` row
  (`INSERT … ON CONFLICT (team_id,user_id) DO UPDATE SET is_manager = TRUE`); set `joined_at`/`added_by`
  sensibly (NOW()/null) when inserting.
- mobile: `ALTER TABLE team_members ADD COLUMN is_manager INTEGER NOT NULL DEFAULT 0;`
  `ALTER TABLE team_members ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';` backfill `updated_at = joined_at`;
  same manager_id→is_manager migration (read teams.manager_id, upsert team_members). Register v15.
- **sync.ts:** in the `/pull` loop (`:210-212`), drop the `team_members ? 'joined_at'` special-case so
  team_members uses `updated_at` like other tables (keep the `media → created_at` case). Remove the now-dead
  `hasUpdatedAt` branch if unused.
- **pull.ts:** team_members upsert → add `is_manager` + `updated_at` (5→7 cols / 7 placeholders);
  `rowToValues` append `row.is_manager ? 1 : 0` and `row.updated_at`. Verify parity.
- [ ] Controller: api+mobile tsc clean; commit `feat(db): migration 015 — team_members.is_manager + updated_at`.

### Unit 2 — `view_team_activity` key + team-manager queries
**Files:** `apps/mobile/src/constants/roles.ts`, `apps/api/src/lib/permissions.ts`,
`apps/mobile/src/db/queries/teams.ts`, `apps/mobile/src/db/queries/log.ts`.
- **Permission key:** add `view_team_activity` to the `Permission` union + every tier map in BOTH files
  (default **true** for tier-2/3/4 manager roles: head_of_construction, head_of_contents, production_manager,
  carpet_cleaning_manager, office_manager, hr_manager, franchise_manager, full_admin; **false** for crew/temp).
  Keep both files byte-identical.
- **teams.ts:** `getTeamsManagedBy(userId): Team[]` (teams where a `team_members` row has
  `user_id=? AND is_manager=1`); `getManagedTeamMemberIds(userId): string[]` (distinct user_ids across those
  teams); `setMemberManager(teamId, userId, isManager: boolean)` (UPDATE team_members SET is_manager,
  updated_at; outbox `UPDATE team_members {team_id,user_id,is_manager,updated_at}` — real boolean, no synced_at);
  extend `TeamMember`/`getTeamMembers` to select `is_manager`. Bump `updated_at` in `addTeamMember`/any write.
- **log.ts:** extend `LogFilter` with `userIds?: string[]`; in `getLogFiltered`, when `userIds` is set, filter
  `user_id IN (…)` (parameterized) — for the offline "My Team" path.
- [ ] Controller: api+mobile tsc clean; commit `feat(teams): view_team_activity perm + manager queries`.

### Unit 3 — Team screens: multi-manager UI
**Files:** `app/(app)/(teams)/index.tsx`, `app/(app)/(teams)/[id].tsx`.
- **[id].tsx:** show ALL managers (members with `is_manager`) on the detail card (chips), not the single
  `manager_id`. In the member list, each member row gets a manager toggle/badge → `setMemberManager` (gated
  `manage_teams`, maintenance-guarded). Keep add/remove member.
- **index.tsx:** team create — drop the single manager picker requirement; create the team, then managers are
  assigned by flagging members on the detail screen (or an optional initial multi-select). Keep `manage_teams`
  gate. (Leave `teams.manager_id` unset/legacy.)
- Preserve outbox conventions + maintenance guards. Manager display reads `is_manager`, not `manager_id`.
- [ ] Controller: mobile tsc clean; commit `feat(teams): multi-manager UI (flag members as managers)`.

### Unit 4 — Cross-team activity ("My Team's Activity")
**Files:** `apps/api/src/routes/logs.ts`, `app/(app)/(logs)/index.tsx`.
- **logs.ts (`GET /logs`):** add `scope=my_teams` (or `team_scope=mine`). When set, resolve the requester's
  managed teams → member user_ids (server-side query: `team_members tm JOIN team_members me ON me.team_id =
  tm.team_id WHERE me.user_id = <requester> AND me.is_manager = TRUE`), then filter
  `activity_log.user_id = ANY(member_ids)`. Gate this scope by `view_team_activity` OR `view_all_logs`
  (a manager without view_all_logs can still use scope=my_teams). Empty managed set → empty result. Keep
  existing filters composable (action/date).
- **logs/index.tsx:** add a **"My Team"** scope/tab, visible when `usePermission('view_team_activity')` (or
  view_all_logs). It fetches `/logs?scope=my_teams&…` server-side (mirror the All-Activity fetch). Offline
  fallback (optional): `getLogFiltered({ userIds: getManagedTeamMemberIds(user.id) })`. Reuse the existing
  row renderer + `MovePhotoThumb`.
- [ ] Controller: mobile+api tsc clean; commit `feat(activity): My Team's Activity (manager cross-team view)`.

---

## File map
| Unit | Files |
|---|---|
| 1 | `apps/api/src/db/migrations/015_team_managers.sql`, `apps/mobile/src/db/migrations/015_team_managers.ts`, `apps/mobile/src/db/schema.ts`, `apps/api/src/routes/sync.ts`, `apps/mobile/src/sync/pull.ts` |
| 2 | `apps/mobile/src/constants/roles.ts`, `apps/api/src/lib/permissions.ts`, `apps/mobile/src/db/queries/teams.ts`, `apps/mobile/src/db/queries/log.ts` |
| 3 | `app/(app)/(teams)/index.tsx`, `app/(app)/(teams)/[id].tsx` |
| 4 | `apps/api/src/routes/logs.ts`, `app/(app)/(logs)/index.tsx` |

## Build order
Wave 0 (foundation, parallel, file-disjoint): Unit 1 (migration+sync) + Unit 2 (perm key + queries).
Wave 1 (after Wave 0; depend on Unit 2): Unit 3 (team screens), Unit 4 (activity).

## Verification
- `tsc --noEmit` clean (mobile + api).
- Migration 015 applies: `team_members.is_manager` + `updated_at` exist; existing single `manager_id` is now a
  `team_members` row with `is_manager=true`; `updated_at` backfilled from `joined_at`.
- Sync: promoting/demoting a manager (is_manager UPDATE) **propagates** across devices (the `updated_at` switch
  — verify a promote pulls to a second device). team_members pull parity 7/7.
- Multi-manager UI: a team shows multiple manager chips; flagging/unflagging a member as manager persists +
  syncs; `manage_teams` + maintenance gates honored.
- `view_team_activity`: appears in the 5a role matrix (20th key); default-on for manager roles; togglable.
- My Team's Activity: a manager sees activity by ALL members of teams they manage, across all jobs/teams; a
  non-manager (no view_team_activity, no view_all_logs) doesn't see the tab and the API rejects scope=my_teams;
  a manager with no managed teams sees an empty feed.
- Server gating: `/logs?scope=my_teams` enforced by view_team_activity/view_all_logs (403 otherwise).

## Out of scope (later)
- 5c bulk user/job ops.
- Per-team permission editing UI (team_permission_overrides exists; not in 5b).
- Dropping the deprecated `teams.manager_id` column (kept for safety; remove in a later cleanup migration).
- Notifications (P3), locations/map (P4).
