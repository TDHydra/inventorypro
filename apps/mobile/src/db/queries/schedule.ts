import { getDb, rowsAs, bindParams } from '../schema';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from './log';
import { runInTransaction } from '../tx';
import { generateUUID } from '../../utils/uuid';
import { getUsersByRole, getAllActiveUsers } from './users';
import type { User } from './users';
import { ROLE_TIER } from '../../constants/roles';

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
    const row = (db.executeSync(`SELECT * FROM schedule_assignments WHERE id = ?`, [assignmentId]).rows[0]) as unknown as ScheduleAssignment | undefined;
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
  const row = (db.executeSync(`SELECT * FROM schedule_assignments WHERE id = ?`, [assignmentId]).rows[0]) as unknown as ScheduleAssignment | undefined;
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
