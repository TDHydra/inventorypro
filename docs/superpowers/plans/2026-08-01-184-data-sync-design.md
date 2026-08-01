# #184 Employee Day Schedule Board — Data + Sync + Permission Layer Design

Design agent output, 2026-08-01. This is the authoritative spec for Track A's data layer (phase A1). File paths relative to repo root.

## 1. Table design

**Table:** `schedule_assignments`
**Grain:** one row = one employee's contiguous time block on one calendar day, pointing at either a job or a "production manager contact."

| Column | Type (PG / SQLite) | Notes |
|---|---|---|
| `id` | UUID / TEXT PK | generated client-side (`generateUUID()`) |
| `employee_id` | UUID / TEXT NOT NULL | soft FK → `users.id` |
| `day` | TEXT NOT NULL | `'YYYY-MM-DD'`, business-calendar day the scheduler picked, not device-TZ-derived |
| `start_minute` | INTEGER NOT NULL | minutes since midnight (0–1439) |
| `end_minute` | INTEGER NOT NULL | minutes since midnight (1–1440), exclusive end |
| `assignment_kind` | TEXT NOT NULL | `'job'` \| `'manager'` — TEXT, never a PG enum (enum trap) |
| `job_id` | UUID / TEXT nullable | soft FK → `jobs.id`, only when kind='job' |
| `manager_id` | UUID / TEXT nullable | soft FK → `users.id` (production_manager), only when kind='manager' |
| `note` | TEXT nullable | free text |
| `created_by` | UUID / TEXT nullable | attribution — forced to caller server-side |
| `active` | BOOLEAN/INTEGER NOT NULL DEFAULT TRUE/1 | soft-delete — clearing never hard-deletes |
| `created_at`, `updated_at` | TIMESTAMPTZ / TEXT NOT NULL | |
| `synced_at` | (mobile only) TEXT nullable | local-only, never pushed |

Rationale: polymorphic kind + nullable FKs mirrors `job_assignments.assignee_kind`; integer minutes make overlap math exact (`!(aEnd <= bStart || aStart >= bEnd)`) and support drag/resize; `day` is a plain TEXT business key like `on_call_shifts.week_start`; soft FKs (no REFERENCES) are sync-order-safe; DELETE is deliberately absent from the sync contract.

Conflict target for upsert: `id` (default — NOT added to CONFLICT_TARGETS). No natural unique key; overlapping rows are a real offline-race scenario resolved by humans.

FULL_TABLES: yes — unscoped org-wide like `job_assignments`; the screen is permission-gated, not row-level sync scope.

Indexes: `(day)`, `(employee_id, day)`, `(job_id)`.

## 2. Migration files

### `apps/api/src/db/migrations/074_schedule_assignments.sql` (new file)

```sql
-- Migration 074: schedule_assignments (#184). Mirrors mobile 059.
-- Employee day schedule graphical assignment board: each row is ONE employee's
-- block of time on ONE day, assigned to either a JOB (assignment_kind='job',
-- job_id set) or a PRODUCTION MANAGER contact (assignment_kind='manager',
-- manager_id set) — never both (enforced in the query layer, not a CHECK
-- constraint). assignment_kind is TEXT 'job' | 'manager' — NEVER a PG enum
-- (enum cols are TEXT on mobile SQLite; remapping enum values crash-loops the
-- API — job_assignments precedent).
-- day is a plain TEXT date key ('YYYY-MM-DD'), the business-calendar day the
-- scheduler is building — not a timezone-converted instant (on_call_shifts
-- week_start precedent). start_minute/end_minute are minutes-since-midnight
-- (0-1440) on that day's wall clock, so overlap math and drag/resize snapping
-- are plain integer arithmetic with no TZ conversion.
-- Soft FKs on employee_id/job_id/manager_id (no REFERENCES — sync-order-safe,
-- job_assignments precedent); created_by is attribution (forced to the caller
-- in syncPolicy.ts). Clearing a slot is a soft-delete (active = FALSE) — rows
-- stay for history, same as job_assignments/on_call_shifts. Overlap prevention
-- is APPLICATION-level only (queries/schedule.ts), never a DB constraint — two
-- offline devices can legitimately race to create overlapping rows before
-- either syncs; see the #184 plan's edge-cases notes.
-- SYNCED table: registered in routes/sync.ts (ALLOWED_TABLES + FULL_TABLES) and
-- lib/syncPolicy.ts (SCHEDULE_ASSIGNMENTS_COLS, OPERATION_PERM manage_schedule,
-- ATTRIBUTION_COLUMNS) in the same change. Table-add only → no backfill, no
-- seed-watermark risk.
CREATE TABLE IF NOT EXISTS schedule_assignments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID NOT NULL,
  day             TEXT NOT NULL,
  start_minute    INTEGER NOT NULL,
  end_minute      INTEGER NOT NULL,
  assignment_kind TEXT NOT NULL,
  job_id          UUID,
  manager_id      UUID,
  note            TEXT,
  created_by      UUID,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS schedule_assignments_day_idx ON schedule_assignments(day);
CREATE INDEX IF NOT EXISTS schedule_assignments_employee_day_idx ON schedule_assignments(employee_id, day);
CREATE INDEX IF NOT EXISTS schedule_assignments_job_idx ON schedule_assignments(job_id);
```

No manual registration — `apps/api/src/db/migrate.ts` auto-discovers via readdirSync.

### `apps/mobile/src/db/migrations/059_schedule_assignments.ts` (new file)

```ts
import type { SqlDb } from '../types';

// Migration 059: schedule_assignments (#184) — employee day schedule graphical
// assignment board. Mirrors API migration 074.
// Each row is ONE employee's block of time on ONE day, assigned to either a JOB
// (assignment_kind='job', job_id set) or a PRODUCTION MANAGER contact
// (assignment_kind='manager', manager_id set) — never both (enforced in the
// query layer). assignment_kind is TEXT (never an enum — job_assignments
// precedent). day is a plain TEXT date key ('YYYY-MM-DD') chosen by the
// scheduler building the board, not derived from device timezone
// (on_call_shifts week_start precedent). start_minute/end_minute are
// minutes-since-midnight (0-1440) on that day's wall clock.
// Soft FKs on employee_id/job_id/manager_id (no REFERENCES — sync-order-safe).
// active 0/1: clearing a slot is a soft-delete — rows stay for history, DELETE
// is not part of the sync contract (job_assignments precedent).
export const migration = {
  version: 59,
  up: (db: SqlDb): void => {
    db.executeSync(`CREATE TABLE IF NOT EXISTS schedule_assignments (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      day TEXT NOT NULL,
      start_minute INTEGER NOT NULL,
      end_minute INTEGER NOT NULL,
      assignment_kind TEXT NOT NULL,
      job_id TEXT,
      manager_id TEXT,
      note TEXT,
      created_by TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT
    )`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS schedule_assignments_day_idx ON schedule_assignments(day)`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS schedule_assignments_employee_day_idx ON schedule_assignments(employee_id, day)`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS schedule_assignments_job_idx ON schedule_assignments(job_id)`);
  },
};
```

Register in BOTH:
- `apps/mobile/src/db/schema.ts` (~line 137, `loadMigrations()`): `const { migration: m059 } = await import('./migrations/059_schedule_assignments');` after m058, add `m059` to the sorted array.
- `apps/mobile/src/db/schema.web.ts` (~line 161): add `import('./migrations/059_schedule_assignments'),` after the 058 import in the `Promise.all([...])` list.

## 3. Sync-plumbing edits, file by file

### `apps/api/src/lib/syncPolicy.ts`

1. `ATTRIBUTION_COLUMNS` (~line 143, next to job_assignments):
```ts
// Schedule board (#184): who built the day's slot is always the authenticated
// caller on INSERT and never reassignable on UPDATE.
schedule_assignments: ['created_by'],
```
2. `OPERATION_PERM` (~line 404):
```ts
// Employee day schedule board (#184): building/editing a slot requires
// manage_schedule. Clearing is a soft-delete (UPDATE active = FALSE); DELETE
// is deliberately absent → fails closed (assignment rows are history, never
// torn down via sync — job_assignments precedent).
schedule_assignments: { INSERT: 'manage_schedule', UPDATE: 'manage_schedule' },
```
(NOT added to OPERATION_PERM_EXEMPT.)
3. New COLS constant (~line 516, next to JOB_ASSIGNMENTS_COLS):
```ts
// schedule_assignments (#184): no financial/secret columns — full synced set.
const SCHEDULE_ASSIGNMENTS_COLS = 'id, employee_id, day, start_minute, end_minute, assignment_kind, job_id, manager_id, note, created_by, active, created_at, updated_at';
```
4. `selectColumnsFor` (~line 541): `if (table === 'schedule_assignments') return SCHEDULE_ASSIGNMENTS_COLS;`
5. `ACTIVITY_ACTIONS` (~line 456, next to job_assigned/job_unassigned):
```ts
// Employee day schedule board (#184): logged against entity_type 'user'
// (entity_id = the EMPLOYEE's uuid — the board is keyed by employee+day, so a
// future "this employee's schedule history" view resolves consistently for
// both job- and manager-kind slots). Kind/day/times/job_id/manager_id ride in
// metadata (activity_log.entity_id is a UUID column, never a free string).
'schedule_assigned', 'schedule_updated', 'schedule_cleared',
```
(ACTIVITY_ENTITY_TYPES already contains 'user' — no change.)

### `apps/api/src/routes/sync.ts`

1. `ALLOWED_TABLES` (~line 46): add `'schedule_assignments',`.
2. `FULL_TABLES` (~line 287), next to job_assignments:
```ts
// Schedule board (#184): unscoped like job_assignments — a fresh device needs
// the org's day-schedule rows to render the board offline; the screen itself
// stays permission-gated (manage_schedule) even though sync isn't row-scoped.
'schedule_assignments',
```
3. Do NOT touch SCOPED_TABLES, CONFLICT_TARGETS, DELETE_FORBIDDEN_TABLES, PRIVILEGED_TABLE_PERM, TAXONOMY_FK_COLUMNS.

### `apps/mobile/src/sync/pull.ts`

1. `TABLE_UPSERT_SQL` (~line 40):
```ts
schedule_assignments: `INSERT OR REPLACE INTO schedule_assignments (id, employee_id, day, start_minute, end_minute, assignment_kind, job_id, manager_id, note, created_by, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
```
2. `rowToValues` (~line 81) — 13 columns, 13 values, order exact:
```ts
case 'schedule_assignments': return [row.id, row.employee_id, row.day, row.start_minute, row.end_minute, row.assignment_kind, row.job_id ?? null, row.manager_id ?? null, row.note ?? null, row.created_by ?? null, row.active ? 1 : 0, row.created_at, row.updated_at];
```

### `apps/mobile/src/sync/fullDownload.ts`

1. `SYNC_TABLES` (~line 38):
```ts
// Schedule board (#184): org-visible like job_assignments — a fresh device
// needs the full day-schedule history to render the board offline.
'schedule_assignments',
```
2. Generic upsert switch (~lines 167–169): add `case 'schedule_assignments':` to the shared case list with job_assignments/rooms (falls into the generic column-intersecting upsert).

### Tests to extend

- `apps/api/src/lib/syncPolicy.test.ts`: `requiredOperationPerm('schedule_assignments','INSERT'|'UPDATE')` → 'manage_schedule', DELETE → 'DENY'; `selectColumnsFor('schedule_assignments', false)` equality; applyWritePolicy attribution test (created_by forced on INSERT, stripped on UPDATE). Copy the job_assignments blocks.
- `apps/api/src/routes/sync-guards.test.ts`: COLUMNS fixture only if adding an integration push test (optional — pure-policy tests are primary coverage per that file's header).

## 4. Permission edits, file by file

New permission: **`manage_schedule`** — "Manage employee schedule board".
Defaults: tier4/tier3/tier2 = true, tier1 + temporary_employee = false. Rationale: daily dispatch authority — same population as `create_jobs`, NOT the narrower `manage_teams` (structural roster changes).

### `apps/mobile/src/constants/roles.ts`
1. `Permission` union (~17–46): insert `| 'manage_schedule'` after 'close_jobs'.
2. `PERMISSION_LABELS` (~53+): `manage_schedule: 'Manage employee schedule board',` (auto-appears in admin role editor via PERMISSION_ORDER = Object.keys(PERMISSION_LABELS)).
3. Tier maps (~183–297), after close_jobs in each: tier4 true, tier3 true, tier2 true, tier1 false; tempEmployee inherits false via `...tier1` spread — no edit. Closed union forces compile errors until all four maps are updated; trust the compiler.
4. ROLE_DEFAULTS (~308): no change.

### `apps/api/src/lib/permissions.ts` ("KEEP IN SYNC" header)
Mirror byte-for-byte: tier4 (~159) true, tier3 (~188) true, tier2 (~217) true, tier1 (~246) false; tempEmployee inherits. This file is `Record<string, boolean>` — the compiler will NOT catch omissions; skipping it makes OPERATION_PERM resolve manage_schedule falsy for everyone → every write 403s.

Not a FULL_ADMIN_FLOOR or FULL_ADMIN_ONLY_GRANT permission — no special-casing.

### Tests
- `apps/mobile/src/constants/roles.test.ts`: existing generic completeness checks — just run.
- `apps/api/src/lib/permissions.test.ts` (~line 168 idiom, EXPECTED_QUICK_ADD): add a manage_schedule parity test asserting every ROLE_DEFAULTS role matches the expected map.

## 5. Query module: `apps/mobile/src/db/queries/schedule.ts` (new file)

Mirrors `jobAssignments.ts` (shared private helper, `runInTransaction`, `appendOutbox` + `appendLog` per write, idempotent guards). Full reference implementation:

```ts
import { getDb, rowsAs, bindParams } from '../schema';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from './log';
import { runInTransaction } from '../tx';
import { generateUUID } from '../../utils/uuid';
import { getUsersByRole } from './users';
import type { User } from './users';

// Employee day schedule board (#184, migration 059 / API 074). Each row is one
// employee's contiguous time block on one day, pointing at either a JOB or a
// PRODUCTION MANAGER contact. Server-side writes require manage_schedule
// (syncPolicy OPERATION_PERM); the UI's screen-level usePermission('manage_schedule')
// gate is the courtesy mirror. Clearing a slot is a soft-delete (active=0,
// job_assignments precedent) — rows stay for history.

export interface ScheduleAssignment {
  id: string;
  employee_id: string;
  day: string; // 'YYYY-MM-DD'
  start_minute: number;
  end_minute: number;
  assignment_kind: 'job' | 'manager';
  job_id: string | null;
  manager_id: string | null;
  note: string | null;
  created_by: string | null;
  active: number; // 0 | 1
  created_at: string;
  updated_at: string;
  synced_at: string | null; // local-only
}

export interface ScheduleAssignmentView extends ScheduleAssignment {
  employee_name: string;
  job_name: string | null;
  job_number: string | null;
  manager_name: string | null;
}

// Thrown by assignJobSlot/assignManagerSlot/updateSlotTimes when the requested
// range overlaps an existing ACTIVE assignment for the same employee/day and
// the caller didn't pass { force: true }. `conflicts` is every overlapping row
// so the UI can show "already assigned to <X> 9:00–11:00".
export class ScheduleConflictError extends Error {
  constructor(public conflicts: ScheduleAssignmentView[]) {
    super('Overlapping schedule assignment');
    this.name = 'ScheduleConflictError';
  }
}

const VIEW_SELECT = `
  SELECT sa.*,
         u.name AS employee_name,
         j.name AS job_name,
         j.job_number AS job_number,
         mgr.name AS manager_name
  FROM schedule_assignments sa
  LEFT JOIN users u ON u.id = sa.employee_id
  LEFT JOIN jobs j ON j.id = sa.job_id AND sa.assignment_kind = 'job'
  LEFT JOIN users mgr ON mgr.id = sa.manager_id AND sa.assignment_kind = 'manager'
`;

export function getScheduleBoardForDay(day: string): ScheduleAssignmentView[] {
  const db = getDb();
  return rowsAs<ScheduleAssignmentView>(db.executeSync(
    `${VIEW_SELECT} WHERE sa.day = ? AND sa.active = 1 ORDER BY u.name ASC, sa.start_minute ASC`,
    [day],
  ).rows);
}

export function getScheduleAssignmentsForEmployee(employeeId: string, day: string): ScheduleAssignmentView[] {
  const db = getDb();
  return rowsAs<ScheduleAssignmentView>(db.executeSync(
    `${VIEW_SELECT} WHERE sa.employee_id = ? AND sa.day = ? AND sa.active = 1 ORDER BY sa.start_minute ASC`,
    [employeeId, day],
  ).rows);
}

// A job can be covered by MANY rows (one per employee per contiguous range):
// the "multi-slot job" case is structural, not a special code path.
export function getScheduleAssignmentsForJob(jobId: string, day?: string): ScheduleAssignmentView[] {
  const db = getDb();
  const clause = day ? `AND sa.day = ?` : '';
  const params = day ? [jobId, day] : [jobId];
  return rowsAs<ScheduleAssignmentView>(db.executeSync(
    `${VIEW_SELECT} WHERE sa.job_id = ? ${clause} AND sa.active = 1 ORDER BY sa.day ASC, sa.start_minute ASC`,
    params,
  ).rows);
}

export function getAssignableManagers(): User[] {
  return getUsersByRole('production_manager');
}

function overlapping(employeeId: string, day: string, startMinute: number, endMinute: number, excludeId?: string): ScheduleAssignmentView[] {
  const db = getDb();
  const excludeClause = excludeId ? `AND sa.id != ?` : '';
  const params: (string | number)[] = [employeeId, day, endMinute, startMinute];
  if (excludeId) params.push(excludeId);
  return rowsAs<ScheduleAssignmentView>(db.executeSync(
    `${VIEW_SELECT}
     WHERE sa.employee_id = ? AND sa.day = ? AND sa.active = 1
       AND sa.start_minute < ? AND sa.end_minute > ? ${excludeClause}`,
    params,
  ).rows);
}

interface SlotInput {
  employeeId: string;
  day: string;
  startMinute: number;
  endMinute: number;
  note?: string | null;
}

// Shared insert path. `force: true` auto-clears (soft-deletes) any overlapping
// active assignment for the same employee/day in the SAME transaction before
// inserting the new one — otherwise an overlap throws ScheduleConflictError
// and nothing is written.
function createSlot(
  input: SlotInput,
  kind: 'job' | 'manager',
  jobId: string | null,
  managerId: string | null,
  actorId: string | null,
  opts: { force?: boolean } = {},
): string {
  const { employeeId, day, startMinute, endMinute, note = null } = input;
  if (endMinute <= startMinute) throw new Error('end_minute must be after start_minute');
  const now = new Date().toISOString();
  const id = generateUUID();
  runInTransaction(() => {
    const db = getDb();
    const conflicts = overlapping(employeeId, day, startMinute, endMinute);
    if (conflicts.length > 0) {
      if (!opts.force) throw new ScheduleConflictError(conflicts);
      for (const c of conflicts) clearSlotInternal(c.id, actorId, now);
    }
    db.executeSync(
      `INSERT INTO schedule_assignments
         (id, employee_id, day, start_minute, end_minute, assignment_kind, job_id, manager_id, note, created_by, active, created_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
      bindParams([id, employeeId, day, startMinute, endMinute, kind, jobId, managerId, note, actorId, now, now]),
    );
    appendOutbox('INSERT', 'schedule_assignments', {
      id, employee_id: employeeId, day, start_minute: startMinute, end_minute: endMinute,
      assignment_kind: kind, job_id: jobId, manager_id: managerId, note,
      created_by: actorId, active: 1, created_at: now, updated_at: now,
    });
    appendLog({
      user_id: actorId,
      team_id: null,
      action: 'schedule_assigned',
      entity_type: 'user',
      entity_id: employeeId,
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      job_id: kind === 'job' ? jobId : null,
      note,
      metadata: JSON.stringify({ assignment_id: id, day, start_minute: startMinute, end_minute: endMinute, assignment_kind: kind, job_id: jobId, manager_id: managerId }),
      device_id: null,
    });
  });
  return id;
}

export function assignJobSlot(input: SlotInput & { jobId: string }, actorId: string | null, opts?: { force?: boolean }): string {
  return createSlot(input, 'job', input.jobId, null, actorId, opts);
}

export function assignManagerSlot(input: SlotInput & { managerId: string }, actorId: string | null, opts?: { force?: boolean }): string {
  return createSlot(input, 'manager', null, input.managerId, actorId, opts);
}

// Drag/resize an existing slot's time range. Re-runs the same overlap guard
// (excluding itself). Throws if the assignment is unknown or already cleared.
export function updateSlotTimes(
  assignmentId: string,
  startMinute: number,
  endMinute: number,
  actorId: string | null,
  opts: { force?: boolean } = {},
): void {
  if (endMinute <= startMinute) throw new Error('end_minute must be after start_minute');
  const now = new Date().toISOString();
  runInTransaction(() => {
    const db = getDb();
    const row = (db.executeSync(`SELECT * FROM schedule_assignments WHERE id = ?`, [assignmentId]).rows[0]) as ScheduleAssignment | undefined;
    if (!row) throw new Error('Assignment not found');
    if (!row.active) throw new Error('Assignment is cleared');
    const conflicts = overlapping(row.employee_id, row.day, startMinute, endMinute, assignmentId);
    if (conflicts.length > 0) {
      if (!opts.force) throw new ScheduleConflictError(conflicts);
      for (const c of conflicts) clearSlotInternal(c.id, actorId, now);
    }
    db.executeSync(
      `UPDATE schedule_assignments SET start_minute = ?, end_minute = ?, updated_at = ? WHERE id = ?`,
      bindParams([startMinute, endMinute, now, assignmentId]),
    );
    appendOutbox('UPDATE', 'schedule_assignments', { id: assignmentId, start_minute: startMinute, end_minute: endMinute, updated_at: now });
    appendLog({
      user_id: actorId, team_id: null, action: 'schedule_updated', entity_type: 'user',
      entity_id: row.employee_id, from_location_id: null, to_location_id: null,
      quantity: null, unit: null, job_id: row.assignment_kind === 'job' ? row.job_id : null,
      note: row.note,
      metadata: JSON.stringify({ assignment_id: assignmentId, day: row.day, start_minute: startMinute, end_minute: endMinute }),
      device_id: null,
    });
  });
}

function clearSlotInternal(assignmentId: string, actorId: string | null, now: string): void {
  const db = getDb();
  const row = (db.executeSync(`SELECT * FROM schedule_assignments WHERE id = ?`, [assignmentId]).rows[0]) as ScheduleAssignment | undefined;
  if (!row || !row.active) return; // no-op-safe against double-taps
  db.executeSync(`UPDATE schedule_assignments SET active = 0, updated_at = ? WHERE id = ?`, bindParams([now, assignmentId]));
  appendOutbox('UPDATE', 'schedule_assignments', { id: assignmentId, active: 0, updated_at: now });
  appendLog({
    user_id: actorId, team_id: null, action: 'schedule_cleared', entity_type: 'user',
    entity_id: row.employee_id, from_location_id: null, to_location_id: null,
    quantity: null, unit: null, job_id: row.assignment_kind === 'job' ? row.job_id : null,
    note: row.note,
    metadata: JSON.stringify({ assignment_id: assignmentId, day: row.day, assignment_kind: row.assignment_kind, job_id: row.job_id, manager_id: row.manager_id }),
    device_id: null,
  });
}

export function clearSlot(assignmentId: string, actorId: string | null): void {
  const exists = getDb().executeSync(`SELECT 1 FROM schedule_assignments WHERE id = ?`, [assignmentId]).rows.length > 0;
  if (!exists) throw new Error('Assignment not found');
  runInTransaction(() => clearSlotInternal(assignmentId, actorId, new Date().toISOString()));
}
```

Checklist notes: outbox payloads never include `synced_at`; `appendLog.entity_id` is always the employee UUID (activity_log.entity_id is a UUID column); the three action strings MUST be in ACTIVITY_ACTIONS or the outbox retries forever; entity_type 'user' already allowlisted.

## 6. Edge cases

- **Overlap:** app-layer guard only (see above); DB constraint would break offline racing. Two offline devices racing → both rows persist → visible double-booking, human-resolved. Not silent loss, not a crash.
- **Multi-slot jobs:** structural — job_id not unique; getScheduleAssignmentsForJob returns all rows.
- **Timezone:** day + minutes are wall-clock, no TZ. Compute `day` like weekMath computes week_start — NEVER `new Date().toISOString().slice(0,10)` (UTC shifts the day near midnight).
- **Sync conflicts:** last-write-wins per row id, like every other operational table.

## 7. Test plan

API: syncPolicy.test.ts (op perms INSERT/UPDATE → manage_schedule, DELETE → DENY; selectColumnsFor equality; attribution forced/stripped), permissions.test.ts parity test, migrationSql.test.ts sweep (no code change, just run).
Mobile: roles.test.ts (existing, just run); new `src/db/queries/schedule.test.ts` on the jobAssignments.test.ts harness (Module._load interception, sql.js testDb): CREATE TABLE fixture + users/jobs fixtures; assignJobSlot row+outbox(no synced_at)+log; assignManagerSlot shape; overlap throws ScheduleConflictError w/ conflicts + writes nothing; force soft-deletes prior (active=0, own outbox UPDATE + schedule_cleared log) and inserts; updateSlotTimes moves/guards/rejects end<=start; clearSlot soft-deletes/no-ops on cleared/throws on unknown; getScheduleBoardForDay filters active+day and joins names; getScheduleAssignmentsForJob multi-row.

## Execution order

1. Migration files; register mobile in schema.ts + schema.web.ts.
2. roles.ts + api permissions.ts — run roles.test.ts immediately.
3. syncPolicy.ts → sync.ts → pull.ts → fullDownload.ts.
4. queries/schedule.ts + schedule.test.ts.
5. Extend syncPolicy.test.ts + permissions.test.ts.
6. Full `pnpm --filter api test` + `pnpm --filter mobile test`.
