import { createRepository, runInTransaction } from '@invenpro/core';
import { getDb, rowsAs } from '../db/schema';
import { generateUUID } from '../utils/uuid';
import { getUsersByRole, getAllActiveUsers } from './users';
import type { User } from './users';
import { ROLE_TIER } from '../constants/roles';

// Station C2 (Wave C): employee day schedule board (#184, migration 059 /
// API 074). Ported from apps/mobile/src/db/queries/schedule.ts, adapted to
// createRepository() per docs/REBUILD-PORTING.md's no-self-log convention.
// Each row is one employee's contiguous time block on one day, pointing at
// either a JOB or a PRODUCTION MANAGER contact. Server-side writes require
// manage_schedule (syncPolicy OPERATION_PERM); the UI's screen-level
// usePermission('manage_schedule') gate is the courtesy mirror. Clearing a
// slot is a soft-delete (active=0, job_assignments precedent) — rows stay
// for history.
//
// Unlike the old app (whose createSlot/updateSlotTimes/clearSlotInternal each
// called appendLog internally), every write below returns whatever the
// caller needs (the new id, and/or the rows it auto-cleared/soft-deleted) so
// the CALLER can build its own appendLog call(s) inside a runInTransaction it
// owns — see src/components/schedule/{AssignmentPickerSheet,
// JobDetailPopup,PmContactPopup}.tsx call sites. The overlap-conflict
// resolution itself (auto-clearing superseded rows before inserting the new
// one) still has to run inside ONE transaction for data-integrity reasons —
// that transaction lives inside this module (createSlot/updateSlotTimes
// below); it's a separate concern from where the activity_log entry gets
// appended.

const scheduleRepo = createRepository('schedule_assignments');

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
// so the UI can show "already assigned to <X> 9:00–11:00" — and so the caller
// can build a 'schedule_cleared' log entry per row if it retries with force.
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

// The board's row roster: active "field crew" tier (ROLE_TIER 1) users —
// the population manage_schedule's tier defaults treat as SUBJECTS of
// scheduling (tier1 + temporary_employee can't edit the board, per the #184
// data design's permission rationale), not managers/dispatchers themselves.
// Filters getAllActiveUsers() by ROLE_TIER instead of hardcoding a role list
// so a future tier-1 role addition (roles.ts) is picked up automatically.
export function getScheduleableEmployees(): User[] {
  return getAllActiveUsers().filter(u => ROLE_TIER[u.role] === 1);
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

/** What a caller needs to build the 'schedule_assigned' (+ any 'schedule_cleared') log entries. */
export interface SlotWriteResult {
  id: string;
  /** Active assignments this write auto-cleared (force: true) to resolve an overlap. */
  cleared: ScheduleAssignmentView[];
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
): SlotWriteResult {
  const { employeeId, day, startMinute, endMinute, note = null } = input;
  if (endMinute <= startMinute) throw new Error('end_minute must be after start_minute');
  const now = new Date().toISOString();
  const id = generateUUID();
  let cleared: ScheduleAssignmentView[] = [];
  runInTransaction(() => {
    const conflicts = overlapping(employeeId, day, startMinute, endMinute);
    if (conflicts.length > 0) {
      if (!opts.force) throw new ScheduleConflictError(conflicts);
      for (const c of conflicts) scheduleRepo.update({ id: c.id, active: false });
      cleared = conflicts;
    }
    scheduleRepo.insert({
      id, employee_id: employeeId, day, start_minute: startMinute, end_minute: endMinute,
      assignment_kind: kind, job_id: jobId, manager_id: managerId, note,
      created_by: actorId, active: true, created_at: now, updated_at: now,
    });
  });
  return { id, cleared };
}

export function assignJobSlot(input: SlotInput & { jobId: string }, actorId: string | null, opts?: { force?: boolean }): SlotWriteResult {
  return createSlot(input, 'job', input.jobId, null, actorId, opts);
}

export function assignManagerSlot(input: SlotInput & { managerId: string }, actorId: string | null, opts?: { force?: boolean }): SlotWriteResult {
  return createSlot(input, 'manager', null, input.managerId, actorId, opts);
}

/** What a caller needs to build the 'schedule_updated' (+ any 'schedule_cleared') log entries. */
export interface SlotUpdateResult {
  /** The row as it was BEFORE the time change (for the log's entity/job/note fields). */
  row: ScheduleAssignment;
  cleared: ScheduleAssignmentView[];
}

// Drag/resize an existing slot's time range. Re-runs the same overlap guard
// (excluding itself). Throws if the assignment is unknown or already cleared.
// (No current screen calls this — ported for parity/future use, same as the
// old app's own unused-by-any-screen query function.)
export function updateSlotTimes(
  assignmentId: string,
  startMinute: number,
  endMinute: number,
  opts: { force?: boolean } = {},
): SlotUpdateResult {
  if (endMinute <= startMinute) throw new Error('end_minute must be after start_minute');
  let clearedOut: ScheduleAssignmentView[] = [];
  let rowOut!: ScheduleAssignment;
  runInTransaction(() => {
    const db = getDb();
    const row = (db.executeSync(`SELECT * FROM schedule_assignments WHERE id = ?`, [assignmentId]).rows[0]) as unknown as ScheduleAssignment | undefined;
    if (!row) throw new Error('Assignment not found');
    if (!row.active) throw new Error('Assignment is cleared');
    rowOut = row;
    const conflicts = overlapping(row.employee_id, row.day, startMinute, endMinute, assignmentId);
    if (conflicts.length > 0) {
      if (!opts.force) throw new ScheduleConflictError(conflicts);
      for (const c of conflicts) scheduleRepo.update({ id: c.id, active: false });
      clearedOut = conflicts;
    }
    scheduleRepo.update({ id: assignmentId, start_minute: startMinute, end_minute: endMinute });
  });
  return { row: rowOut, cleared: clearedOut };
}

// Standalone "Clear this slot" action (JobDetailPopup/PmContactPopup). Returns
// the cleared row (for the caller's 'schedule_cleared' log) or null when the
// row was already inactive (no-op-safe against double-taps, no write/log).
// Throws if the assignment is unknown locally.
export function clearSlot(assignmentId: string): ScheduleAssignmentView | null {
  let result: ScheduleAssignmentView | null = null;
  runInTransaction(() => {
    const row = rowsAs<ScheduleAssignmentView>(getDb().executeSync(
      `${VIEW_SELECT} WHERE sa.id = ?`, [assignmentId],
    ).rows)[0];
    if (!row) throw new Error('Assignment not found');
    if (!row.active) { result = null; return; }
    scheduleRepo.update({ id: assignmentId, active: false });
    result = row;
  });
  return result;
}
