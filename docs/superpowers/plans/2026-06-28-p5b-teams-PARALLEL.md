# P5 · 5b — Multi-Manager Teams + Cross-Team Activity — Implementation Plan

> Ultramode/SDD. Gate per task: `npx tsc --noEmit` clean (mobile + api). Implementers do NO git/tsc.

**Goal:** multiple managers per team (members flagged `is_manager`, migrating the single `manager_id`); a
manager "My Team's Activity" view (members' activity everywhere) behind a new `view_team_activity` permission.
One migration (015); no native deps. **Full spec:** `docs/superpowers/specs/2026-06-28-p5b-teams-design.md`
— ships with every brief.

## Global Constraints
- Expo SDK 56; op-sqlite binds `string|number|null|ArrayBuffer`. **Migration 015; no native, one new permission key.**
- `team_members` is synced (composite conflict `team_id,user_id`). **Switch its incremental-pull timestamp from
  `joined_at` to a new `updated_at`** (is_manager is mutable). Update pull.ts parity.
- Add `view_team_activity` to BOTH mobile `constants/roles.ts` and api `lib/permissions.ts`, identically (keys stay hardcoded).
- Outbox: real booleans, strip `synced_at`. Maintenance guards: `isWriteBlocked()`, `<MaintenanceBanner/>`, `disabled={locked}`.

---

# WAVE 0 (foundation, parallel, file-disjoint)

### Task 1: Migration 015 + team_members sync switch
**Files:** `apps/api/src/db/migrations/015_team_managers.sql`, `apps/mobile/src/db/migrations/015_team_managers.ts`,
`apps/mobile/src/db/schema.ts`, `apps/api/src/routes/sync.ts`, `apps/mobile/src/sync/pull.ts`.
- api: ADD COLUMN IF NOT EXISTS `is_manager BOOLEAN NOT NULL DEFAULT FALSE` + `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
  backfill `updated_at = joined_at`; migrate: for each team.manager_id non-null, `INSERT INTO team_members(team_id,user_id,is_manager,joined_at,updated_at) … ON CONFLICT (team_id,user_id) DO UPDATE SET is_manager=TRUE, updated_at=NOW()`.
- mobile: ADD COLUMN `is_manager INTEGER NOT NULL DEFAULT 0` + `updated_at TEXT NOT NULL DEFAULT ''`; backfill
  `updated_at = joined_at`; same manager_id→is_manager migration (read teams.manager_id). Register v15 in schema.ts.
- sync.ts `/pull` loop (~:210): remove the `team_members ? 'joined_at'` special-case → team_members uses
  `updated_at` (keep `media → created_at`); drop the now-dead `hasUpdatedAt` branch.
- pull.ts: team_members upsert add `is_manager` + `updated_at` (5→7 cols/placeholders); rowToValues append
  `row.is_manager ? 1 : 0` and `row.updated_at`. Verify parity.
- [ ] Controller: api+mobile tsc clean; commit `feat(db): migration 015 — team_members.is_manager + updated_at`.

### Task 2: view_team_activity key + manager queries
**Files:** `apps/mobile/src/constants/roles.ts`, `apps/api/src/lib/permissions.ts`,
`apps/mobile/src/db/queries/teams.ts`, `apps/mobile/src/db/queries/log.ts`.
- Add `view_team_activity` to the Permission union + every tier map in BOTH files (default TRUE for
  head_of_construction/head_of_contents/production_manager/carpet_cleaning_manager/office_manager/hr_manager/
  franchise_manager/full_admin; FALSE for crews/temp). Keep both files identical.
- teams.ts: `getTeamsManagedBy(userId)`, `getManagedTeamMemberIds(userId)` (distinct member user_ids across
  teams where the user has is_manager=1), `setMemberManager(teamId,userId,isManager)` (UPDATE is_manager +
  updated_at; outbox UPDATE team_members {team_id,user_id,is_manager,updated_at} — real boolean, no synced_at);
  add `is_manager` to `TeamMember` + `getTeamMembers` select; set `updated_at` in addTeamMember.
- log.ts: extend `LogFilter` with `userIds?: string[]`; `getLogFiltered` filters `user_id IN (…)` when set (parameterized).
- [ ] Controller: api+mobile tsc clean; commit `feat(teams): view_team_activity perm + manager queries`.

# WAVE 1 (after Wave 0; depend on Task 2; file-disjoint)

### Task 3: Team screens — multi-manager UI
**Files:** `app/(app)/(teams)/[id].tsx`, `app/(app)/(teams)/index.tsx`.
- [id].tsx: detail card shows ALL managers (members with is_manager) as chips; each member row gets a
  manager toggle/badge → `setMemberManager` (gated manage_teams; maintenance-guarded). Keep add/remove member.
- index.tsx: team create no longer requires the single manager picker; managers are flagged on the detail
  screen after creation (optional initial multi-select OK). Keep manage_teams gate. Display reads is_manager,
  not manager_id.
- [ ] Controller: mobile tsc clean; commit `feat(teams): multi-manager UI (flag members as managers)`.

### Task 4: Cross-team activity — My Team's Activity
**Files:** `apps/api/src/routes/logs.ts`, `app/(app)/(logs)/index.tsx`.
- logs.ts GET /logs: add `scope=my_teams`. When set, resolve requester's managed-team member ids
  (`team_members tm JOIN team_members me ON me.team_id=tm.team_id WHERE me.user_id=<req> AND me.is_manager=TRUE`)
  and filter `activity_log.user_id = ANY($ids)`; gate the scope by `view_team_activity` OR `view_all_logs`
  (403 otherwise); empty managed set → empty result; keep other filters composable.
- logs/index.tsx: add a "My Team" scope/tab visible when `usePermission('view_team_activity')` (or view_all_logs);
  fetch `/logs?scope=my_teams&…` (mirror All-Activity fetch); optional offline fallback
  `getLogFiltered({ userIds: getManagedTeamMemberIds(user.id) })`. Reuse the existing row renderer + MovePhotoThumb.
- [ ] Controller: mobile+api tsc clean; commit `feat(activity): My Team's Activity (manager cross-team view)`.

# SHIP (controller)
- [ ] App-wide tsc; whole-branch review (opus): migration 015 cross-platform + manager_id→is_manager migration
  correctness; team_members sync switch (joined_at→updated_at) + pull.ts 7/7 parity; promote/demote actually
  syncs (mutable row now propagates); view_team_activity added identically in both perm files + appears in 5a
  matrix; multi-manager UI reads is_manager not manager_id; scope=my_teams server gating (view_team_activity OR
  view_all_logs) + correct member-id resolution; no regressions to existing team add/remove or logs tabs.
  Merge → main, push. **Deploy:** migration 015 → API redeploy to Unraid (verify schema_migrations=15). No enum
  trap (is_manager BOOLEAN, updated_at TIMESTAMPTZ — additive columns).

## Self-Review
- Spec coverage: U1→T1; U2→T2; U3→T3; U4→T4. ✔
- Collision: T1 migrations+schema.ts+sync.ts+pull.ts; T2 roles.ts+lib/permissions.ts+teams.ts+log.ts; T3 teams screens; T4 logs.ts(api)+logs screen. sync.ts only T1; lib/permissions.ts only T2; logs.ts(api) only T4. Wave-1 disjoint. ✔
- Risk: T1 team_members sync-timestamp switch (must backfill updated_at + remove special-case so promotes
  propagate) and the manager_id migration; final review verifies a promote round-trips and member-id resolution
  for scope=my_teams is correct + gated.
