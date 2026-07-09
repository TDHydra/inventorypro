# Teams Scoping + Role-Aware Team Pages

Confidentiality fix: stop shipping every team's roster and permission overrides to every device.
Then split the team UI by what the viewer actually is (member / manager / org admin).

## Two corrections to earlier claims — read before planning around them

1. **`activity_log` is NOT synced to devices.** It is absent from `FULL_TABLES` (`apps/api/src/routes/sync.ts:103-110`);
   it is push-only/append-only. Devices upload activity rows and never download them. Team activity is
   already REST-only via `routes/logs.ts`, already permission-gated. **It is not part of the leak.**
2. **`jobs` has NO `team_id` column.** The `team_id` at `001_initial_schema.sql:150` belongs to
   `activity_log` (its `CREATE TABLE` starts at :147). `jobs` (:134) is `id, name, status, created_by,
   created_at, updated_at`; the seven later `ALTER TABLE jobs` migrations never add a team. Jobs are not
   associated with teams at all today.

**The actual leak is exactly two tables: `teams` and `team_members`** (the latter carries
`team_permission_overrides`). Both are in `FULL_TABLES` with no scoping, so every enrolled device holds
every team's roster and per-team permission grants.

## Decisions (locked)

- **Visibility:** you always see teams you belong to. You see all teams only with `view_all_logs` OR
  `manage_teams`. No new permission key.
- **Jobs:** add `jobs.team_id`, and scope it. A job with `team_id IS NULL` is visible to **everyone**
  (so nothing vanishes from any device on deploy — every existing job has `team_id NULL`).
- **A team manager, on their own team, may NOT:** add/remove managers; remove themselves; rename or
  delete the team; grant a team override they do not themselves hold. **Enforced server-side** in the
  `/sync/push` guard, not merely grayed out.

---

## Phase 0 — DB core (ONE agent, serialized. Nobody else touches these files.)

Owns: `apps/api/src/routes/sync.ts`, `apps/api/src/lib/syncPolicy.ts`, `apps/api/src/lib/teamAuthority.ts` (new),
`apps/api/src/db/migrations/043_*.sql` (new), `apps/mobile/src/sync/pull.ts`, `apps/mobile/src/sync/fullDownload.ts`,
`apps/mobile/src/db/schema.ts`, `apps/mobile/src/db/schema.web.ts`, `apps/mobile/src/db/migrations/035_*.ts` (new).

### 0a. API migration `043_jobs_team_scoping.sql`
```sql
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id) ON DELETE SET NULL;
-- teamScopeSql runs `IN (SELECT team_id FROM team_members WHERE user_id = $n)` on every
-- non-privileged pull AND full, for three tables. Without these it is a seq scan per request.
CREATE INDEX IF NOT EXISTS team_members_user_idx ON team_members(user_id);
CREATE INDEX IF NOT EXISTS team_members_team_user_idx ON team_members(team_id, user_id);
CREATE INDEX IF NOT EXISTS jobs_team_idx ON jobs(team_id);
-- Watermark touch: incremental pull is `WHERE updated_at > $since`. A device that misses the
-- runtime purge relies on incremental pull, and rows not modified recently fall below its
-- watermark and are never re-sent. Belt-and-suspenders for the flag purge in 0e.
UPDATE teams SET updated_at = NOW();
UPDATE team_members SET updated_at = NOW();
```

### 0b. `teamScopeSql` — a sibling to the existing `chatScopeSql` (`sync.ts:85-93`)

Do **not** add `team_members: 'user_id'` to `SCOPED_TABLES`. That single-column map would show a user
only *their own* membership row, not their teammates' — the exact bug `chatScopeSql` exists to avoid for
`conversation_participants`.

```ts
// callerParam differs per endpoint: '$2' in /sync/pull ($1 = since), '$3' in /sync/full
// ($1 = limit, $2 = offset). Binding the wrong index silently returns empty or mis-scoped rows.
function teamScopeSql(table: string, callerParam: string): string | null {
  const mine = `SELECT team_id FROM team_members WHERE user_id = ${callerParam}`;
  switch (table) {
    case 'teams':        return `id IN (${mine})`;
    case 'team_members': return `team_id IN (${mine})`;
    case 'jobs':         return `(team_id IS NULL OR team_id IN (${mine}))`;
    default:             return null;
  }
}
```

Gate it per request:
```ts
// APEX BYPASS IS MANDATORY. canSeeAllTeams is a permission-matrix lookup; if the matrix does not
// happen to grant full_admin one of these keys, the apex role would download only its own teams.
const canSeeAllTeams =
  effectiveTier(caller.role) === 5 || can('view_all_logs') || can('manage_teams');
```
Attach in **both** scope blocks — `/sync/full` (~`sync.ts:484-486`, `WHERE ${scope}`) and `/sync/pull`
(~`sync.ts:530-532`, `AND ${scope}`) — and fold into the existing `scoped` flag so `userId` is bound.

**Leave `selectColumnsFor`'s `teams`/`team_members` `'*'` fallthrough alone.** Hardening the projection
means hand-mirroring the mobile upsert lists byte-for-byte; bundling it with scoping is how you silently
drop a column. Separate change, separately verified.

### 0c. `jobs.team_id` is a synced column → follow `docs/SYNC-MIGRATION-CHECKLIST.md`
- `pull.ts` `TABLE_UPSERT_SQL.jobs` (line 14): add `team_id` → **16 columns, 16 placeholders**.
- `pull.ts` `rowToValues` `case 'jobs'` (line 40): add `row.team_id ?? null` in the **same position**.
- Mobile migration `035_jobs_team_id.ts`: `ALTER TABLE jobs ADD COLUMN team_id TEXT;`
- **Register 035 in BOTH `schema.ts` AND `schema.web.ts`.** (Verified: both currently hold the same 34
  migrations. Web/sql.js has its own array; a migration in only one means web throws "no column named team_id".)
- `fullDownload.ts` handles `jobs` via the generic arm (names columns from `Object.keys(row)`) → no change.

### 0d. `resolveTeamAuthority` — ONE helper, both enforcement paths

`/sync/push` and the REST mirrors in `routes/teams.ts` will drift and reopen a bypass on whichever lags.
Back both with one helper. Resolve `is_manager` **from the authenticated `sub`**, never from the payload.

```ts
// Returns { orgAdmin, managerOnly }. ORDER MATTERS: check org authority FIRST.
// A franchise_manager who also manages a crew must not be demoted to manager-only
// and locked out of renaming their own team.
export async function resolveTeamAuthority(pg, callerId, teamId): Promise<{orgAdmin: boolean; managerOnly: boolean}>
```
Apply the four manager prohibitions **only when `managerOnly && !orgAdmin`**. Note `is_manager` is already
in `SENSITIVE_DENY['team_members']` (sync push can never write it) and over-grants are already blocked by
`sanitizeTeamOverrides` + `canActOnTarget` — this guard covers rename/delete/self-remove and the REST path.

### 0e. Purge — repeatable, never `resetLocalDb`

`resetLocalDb` drops the **outbox** = silent loss of un-pushed offline field edits. Instead:

```
DELETE FROM team_members; DELETE FROM teams;   -- targeted, outbox untouched
runFullDownload(['teams','team_members'])       -- same sync, ~no empty-teams window
clear flag only on re-download success
```

**It must be repeatable, not one-shot.** Scoped incremental pull is upsert-only and never deletes, so
when a user is *removed* from a team the forbidden rows persist on their device forever. On every
authenticated full download, diff the server's authoritative set and delete local rows no longer returned.
A one-shot migration fixes today's leak and leaves an ongoing revocation hole.

---

## Phase 1 — Server enforcement + prerequisites (2 agents, disjoint)

| Agent | Owns | Task |
| --- | --- | --- |
| P1-push | `apps/api/src/routes/teams.ts` | Call `resolveTeamAuthority` from the REST rename/delete/member/manager paths. |
| P1-session | `apps/api/src/lib/session.ts` | **Prerequisite, not a detail:** populate `team_contexts` in `buildUserSession` from `team_members`. `apps/mobile/src/auth/permissions.ts:90` reads it but nothing ever writes it, so `team_permission_overrides` have **zero client effect today** — the manager permission-grant UI is cosmetic until this lands. Keep the push guard's org-admin test strictly role-level so a team-scoped grant can't masquerade as org authority. |

**Also required (P1-push):** mark authorization rejections as **permanent**, distinct from transient
FK/conflict errors. Otherwise a rejected write retries `MAX_ATTEMPTS=5`, dead-letters, and still counts as
pending — reproducing the known "sync stuck on N pending" symptom.

## Phase 2 — UI (3 agents, disjoint files, after Phase 0)

| Agent | Owns | Task |
| --- | --- | --- |
| P2-list | `app/(app)/(teams)/index.tsx` | Split: "My Teams" always; "All Teams" section only when `view_all_logs \|\| manage_teams`. |
| P2-detail | `app/(app)/(teams)/[id].tsx` | Member view vs manager view. Gray out the four manager-prohibited controls with a reason. **Add a `getMyMembership` deep-link guard** — render "not a member" when there is no membership row and no org perm. Covers the pre-purge window and any web client. |
| P2-jobs | `app/(app)/(jobs)/create.tsx`, `[id].tsx` | Assign a job to a team (optional; NULL = org-wide). Show the team on the job card. |

**Do not narrow `getAllTeams` / `getTeamMembers`.** `broadcast.tsx`, `users.tsx`, the logs filter, and
`NotificationRoutingEditor` all read them from local SQLite and legitimately need the org-wide set. Add
*new* scoped queries (`getTeamsForUser`) rather than changing the existing ones.

**The client gray-out is stale by design.** A manager demoted server-side keeps `is_manager = 1` locally
until the next pull. The server guard is the enforcement of record; the UI is a courtesy. Re-pull
membership on team-screen focus so it self-corrects.

---

## Out of scope (decided, not forgotten)

- **Chat is orthogonal.** `chatScopeSql` scopes by `conversation_participants`, not team membership.
  Removing someone from a team does **not** remove them from a team-linked conversation. Either delete the
  participant rows on team removal, or accept that chat access is governed solely by participant rows.
- **`selectColumnsFor` projection hardening** — separate change (see 0b).
- **Dashboard aggregates** computed from local SQLite will under-count for non-org users after scoping.
  Route org-wide tiles through an org-perm-gated REST count, or accept scoped counts by design.

## Verification

1. `apps/api`: `npx tsc --noEmit` + `npm test`. Add a test asserting a non-org caller's `/sync/pull`
   returns only their teams, and that a manager-crafted `team_members` push with `is_manager` or a
   foreign `added_by` is rejected.
2. `apps/mobile`: `npx tsc --noEmit` + `npm test`. Assert `TABLE_UPSERT_SQL.jobs` column count ==
   placeholder count == `rowToValues('jobs')` length.
3. Deploy API (migration 043 runs on boot), then hotload. On a crew-member account: confirm only their
   team appears, `sqlite3` the device DB and confirm foreign `teams`/`team_members` rows are **gone**.
   On a full_admin: confirm all teams still appear (apex bypass).
4. Confirm no dead-lettered outbox entries after a rejected manager write (sync dot must not stick).
