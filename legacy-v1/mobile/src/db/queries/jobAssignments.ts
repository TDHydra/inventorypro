import { getDb, rowsAs, bindParams } from '../schema';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from './log';
import { runInTransaction } from '../tx';
import { generateUUID } from '../../utils/uuid';
import type { Job } from './jobs';
import { resolveLabels } from './taxonomy';

// Job assignments (#160, migration 051 / API 063): a job is assigned to a
// SUBTEAM (crew) — or to an individual user for techs without a crew. Crew
// membership resolves at READ time from team_members.subteam_id, so a crew's
// helpers are automatically included and a roster change updates everyone's
// "My jobs" with no assignment rewrite. Unassign is a soft-delete (active = 0,
// subteams precedent) — rows stay for history, DELETE is not part of the sync
// contract. Server-side, writes require create_jobs (syncPolicy OPERATION_PERM,
// same gate as the jobs table); the job-detail UI's usePermission('create_jobs')
// gate is the courtesy mirror.

export interface JobAssignment {
  id: string;
  job_id: string;
  assignee_kind: 'user' | 'subteam';
  assignee_id: string;
  assigned_by: string | null;
  active: number; // 0 | 1 (SQLite has no boolean)
  created_at: string;
  updated_at: string;
  synced_at: string | null; // local-only
}

// The denormalized shape the job-detail section renders.
export interface JobAssignmentView extends JobAssignment {
  assignee_name: string;
}

// A crew offered by the assign picker: crew name + owning team + lead, all
// resolved locally (subteams the device holds — org authority pulls them all,
// a team-scoped device only its own, which is exactly what it may offer).
export interface AssignableCrew {
  id: string;
  name: string;
  team_name: string | null;
  lead_name: string | null;
}

// Active assignments of a job with assignee names resolved (crew name or user
// name; a not-yet-synced assignee id degrades to the raw id, never a crash).
export function getAssignmentsForJob(jobId: string): JobAssignmentView[] {
  const db = getDb();
  return rowsAs<JobAssignmentView>(db.executeSync(
    `SELECT ja.*,
            COALESCE(
              CASE ja.assignee_kind WHEN 'subteam' THEN st.name ELSE u.name END,
              ja.assignee_id
            ) AS assignee_name
     FROM job_assignments ja
     LEFT JOIN subteams st ON st.id = ja.assignee_id AND ja.assignee_kind = 'subteam'
     LEFT JOIN users u ON u.id = ja.assignee_id AND ja.assignee_kind = 'user'
     WHERE ja.job_id = ? AND ja.active = 1
     ORDER BY ja.created_at ASC`,
    [jobId],
  ).rows);
}

// Active crews the assign picker can offer, with team + lead context.
export function getAssignableCrews(): AssignableCrew[] {
  const db = getDb();
  return rowsAs<AssignableCrew>(db.executeSync(
    `SELECT s.id, s.name, t.name AS team_name,
            (SELECT u.name FROM team_members tm
             JOIN users u ON u.id = tm.user_id
             WHERE tm.subteam_id = s.id AND tm.subteam_role = 'lead'
             ORDER BY u.name ASC LIMIT 1) AS lead_name
     FROM subteams s
     LEFT JOIN teams t ON t.id = s.team_id
     WHERE s.active = 1
     ORDER BY s.name ASC`,
  ).rows);
}

// Open jobs assigned to me — directly (assignee_kind 'user') OR via any crew I
// belong to (team_members.subteam_id, resolved at read time so helpers are
// automatically included). Inactive assignments and closed/archived jobs are
// excluded. Powers the 'my-jobs' WorkList source.
export function getMyAssignedJobs(userId: string): Job[] {
  const db = getDb();
  const rows = rowsAs<Job>(db.executeSync(
    `SELECT DISTINCT j.* FROM jobs j
     JOIN job_assignments ja ON ja.job_id = j.id AND ja.active = 1
     WHERE j.status = 'open'
       AND (
         (ja.assignee_kind = 'user' AND ja.assignee_id = ?)
         OR (ja.assignee_kind = 'subteam' AND ja.assignee_id IN (
           SELECT tm.subteam_id FROM team_members tm
           WHERE tm.user_id = ? AND tm.subteam_id IS NOT NULL
         ))
       )
     ORDER BY j.updated_at DESC`,
    [userId, userId],
  ).rows);
  return resolveLabels(rows, 'type_id', 'type');
}

function activeAssignmentExists(jobId: string, kind: 'user' | 'subteam', assigneeId: string): boolean {
  const db = getDb();
  return db.executeSync(
    `SELECT 1 FROM job_assignments
     WHERE job_id = ? AND assignee_kind = ? AND assignee_id = ? AND active = 1
     LIMIT 1`,
    [jobId, kind, assigneeId],
  ).rows.length > 0;
}

// Shared insert path: local row + outbox INSERT (synced_at stripped — the
// server table has no such column; assigned_by is stamped locally for instant
// display but the server re-forces it to the authenticated caller via
// ATTRIBUTION_COLUMNS) + one activity_log entry. Atomic. Idempotent on an
// already-active identical assignment (returns the existing id, no new row/
// outbox/log — safe against double-taps). Returns the assignment id.
// NOTE activity_log.entity_id is a UUID column server-side — the JOB id goes
// there; the assignee kind/id ride in metadata.
function assign(
  jobId: string,
  kind: 'user' | 'subteam',
  assigneeId: string,
  assigneeName: string | null,
  actorId: string | null,
): string {
  const now = new Date().toISOString();
  const id = generateUUID();
  let existing: string | null = null;
  runInTransaction(() => {
    const db = getDb();
    const prior = db.executeSync(
      `SELECT id FROM job_assignments
       WHERE job_id = ? AND assignee_kind = ? AND assignee_id = ? AND active = 1
       LIMIT 1`,
      [jobId, kind, assigneeId],
    ).rows[0] as { id: string } | undefined;
    if (prior) { existing = prior.id; return; }
    db.executeSync(
      `INSERT INTO job_assignments
         (id, job_id, assignee_kind, assignee_id, assigned_by, active, created_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
      bindParams([id, jobId, kind, assigneeId, actorId, now, now]),
    );
    appendOutbox('INSERT', 'job_assignments', {
      id, job_id: jobId, assignee_kind: kind, assignee_id: assigneeId,
      assigned_by: actorId, active: 1, created_at: now, updated_at: now,
    });
    appendLog({
      user_id: actorId,
      team_id: null,
      action: 'job_assigned',
      entity_type: 'job',
      entity_id: jobId,
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      job_id: jobId,
      note: assigneeName,
      metadata: JSON.stringify({ assignment_id: id, assignee_kind: kind, assignee_id: assigneeId }),
      device_id: null,
    });
  });
  return existing ?? id;
}

// Assign a job to a crew (subteam). Helpers resolve at read time — assigning
// the crew covers its whole current roster, now and after roster changes.
export function assignJobToCrew(jobId: string, subteamId: string, actorId: string | null): string {
  const db = getDb();
  const st = db.executeSync(`SELECT name FROM subteams WHERE id = ?`, [subteamId])
    .rows[0] as { name: string } | undefined;
  return assign(jobId, 'subteam', subteamId, st?.name ?? null, actorId);
}

// Assign a job directly to one user (techs without a crew).
export function assignJobToUser(jobId: string, userId: string, actorId: string | null): string {
  const db = getDb();
  const u = db.executeSync(`SELECT name FROM users WHERE id = ?`, [userId])
    .rows[0] as { name: string } | undefined;
  return assign(jobId, 'user', userId, u?.name ?? null, actorId);
}

// Remove an assignment: active → 0 (soft-delete; the row stays for history).
// Throws if the assignment is unknown locally (rolls back any enclosing
// transaction). No-op-safe against double-taps only via the active guard:
// unassigning an already-inactive row does nothing (no outbox/log).
export function unassign(assignmentId: string, actorId: string | null): void {
  const now = new Date().toISOString();
  runInTransaction(() => {
    const db = getDb();
    const row = rowsAs<JobAssignmentView>(db.executeSync(
      `SELECT ja.*,
              COALESCE(
                CASE ja.assignee_kind WHEN 'subteam' THEN st.name ELSE u.name END,
                ja.assignee_id
              ) AS assignee_name
       FROM job_assignments ja
       LEFT JOIN subteams st ON st.id = ja.assignee_id AND ja.assignee_kind = 'subteam'
       LEFT JOIN users u ON u.id = ja.assignee_id AND ja.assignee_kind = 'user'
       WHERE ja.id = ?`,
      [assignmentId],
    ).rows)[0];
    if (!row) throw new Error('Assignment not found');
    if (!row.active) return;
    db.executeSync(
      `UPDATE job_assignments SET active = 0, updated_at = ? WHERE id = ?`,
      bindParams([now, assignmentId]),
    );
    appendOutbox('UPDATE', 'job_assignments', { id: assignmentId, active: 0, updated_at: now });
    appendLog({
      user_id: actorId,
      team_id: null,
      action: 'job_unassigned',
      entity_type: 'job',
      entity_id: row.job_id,
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      job_id: row.job_id,
      note: row.assignee_name,
      metadata: JSON.stringify({ assignment_id: assignmentId, assignee_kind: row.assignee_kind, assignee_id: row.assignee_id }),
      device_id: null,
    });
  });
}
