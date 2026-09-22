import { createRepository, runInTransaction, appendOutbox } from '@invenpro/core';
import { getDb, rowsAs } from '../db/schema';
import { resolveLabels, resolveTypeId, JOB_CATEGORY } from './taxonomy';
import { appendLog } from '../db/queries/log';
import { generateUUID } from '../utils/uuid';

// Station C1 (Wave C): full jobs + job_assignments domain. Ported from
// apps/mobile/src/db/queries/jobs.ts + jobAssignments.ts. Reads stay the same
// hand-written SQL as the Wave A stub; writes now go through
// createRepository('jobs')/createRepository('job_assignments') per
// docs/REBUILD-PORTING.md, except assign()/unassign() below which keep the old
// app's self-logging (documented at that function).

const jobsRepo = createRepository('jobs');
// job_assignments writes (assign/unassign below) use raw SQL + appendOutbox
// directly instead of createRepository('job_assignments') — see assign()'s
// header comment for why.

export interface Job {
  id: string;
  name: string;
  status: 'open' | 'closed' | 'archived';
  created_by: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
  // Work-order fields. Optional so existing Job literals stay valid;
  // job_number is assigned server-side on insert when left null.
  job_number?: string | null;
  customer_name?: string | null;
  site_address?: string | null;
  site_location_id?: string | null;
  description?: string | null;
  // Taxonomy type: `type` is the label; `type_id` is the durable FK to
  // taxonomy_types so renames don't orphan the job.
  type?: string | null;
  type_id?: string | null;
  // External reference # — insurance claim / customer PO. Distinct from the
  // server-assigned internal job_number; user-supplied.
  reference_number?: string | null;
  // Insurance carrier/company name. Distinct from reference_number which
  // holds the claim #/customer PO.
  insurance_carrier?: string | null;
  // Owning team. NULL means org-wide: visible to everyone. Once set, the
  // scoped pull stops returning this job to devices outside that team.
  team_id?: string | null;
}

export function getOpenJobs(): Job[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM jobs WHERE status = 'open' ORDER BY updated_at DESC`
  );
  // Resolve `type` from type_id so a taxonomy rename shows immediately.
  return resolveLabels(rowsAs<Job>(result.rows), 'type_id', 'type');
}

export function searchJobs(query: string): Job[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM jobs
     WHERE status = 'open' AND name LIKE ?
     ORDER BY updated_at DESC
     LIMIT 20`,
    [`%${query}%`]
  );
  return resolveLabels(rowsAs<Job>(result.rows), 'type_id', 'type');
}

export function getJobById(id: string): Job | null {
  const db = getDb();
  const result = db.executeSync(`SELECT * FROM jobs WHERE id = ?`, [id]);
  return resolveLabels(rowsAs<Job>(result.rows), 'type_id', 'type')[0] ?? null;
}

// Ported from apps/mobile/src/db/queries/jobs.ts (READ-ONLY — the checkout/
// check-in wizard's "count-based active checkouts" list). Note: this is the
// old app's actual query verbatim, including its known quirk — a returned
// (checked-in) checkout still shows up here forever, since activity_log is
// append-only and there's no "returned" flag on the checkout_to_job row. Not
// this wave's problem to fix; ported as-is for identical domain behavior.
export interface ActiveCheckout {
  id: string;
  user_id: string | null;
  team_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  from_location_id: string | null;
  to_location_id: string | null;
  quantity: number;
  unit: string | null;
  job_id: string | null;
  note: string | null;
  metadata: string | null;
  device_id: string | null;
  created_at: string;
  synced_at: string | null;
  item_name: string;
  job_name: string | null;
  location_name: string | null;
}

export function getActiveCheckoutsForUser(userId: string): ActiveCheckout[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT al.*, i.name AS item_name, i.unit, j.name AS job_name, l.name AS location_name
     FROM activity_log al
     JOIN inventory_items i ON i.id = al.entity_id
     LEFT JOIN jobs j ON j.id = al.job_id
     LEFT JOIN locations l ON l.id = al.from_location_id
     WHERE al.user_id = ?
       AND al.action = 'checkout_to_job'
       AND al.entity_type = 'item'
       AND i.unit_tracked = 0
     ORDER BY al.created_at DESC`,
    [userId]
  );
  return rowsAs<ActiveCheckout>(result.rows);
}

// Most recent job for a customer (case-insensitive) — offers cross-fill of that
// customer's usual details on the create form.
export interface CustomerJobDetails {
  site_address: string | null;
  insurance_carrier: string | null;
  site_location_id: string | null;
  site_location_label: string | null;
}

export function getLatestJobByCustomer(name: string): CustomerJobDetails | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const db = getDb();
  const row = db.executeSync(
    `SELECT j.site_address, j.insurance_carrier, j.site_location_id, l.name AS site_location_label
     FROM jobs j
     LEFT JOIN locations l ON l.id = j.site_location_id
     WHERE LOWER(TRIM(j.customer_name)) = LOWER(?)
     ORDER BY j.updated_at DESC LIMIT 1`,
    [trimmed],
  ).rows[0] as unknown as CustomerJobDetails | undefined;
  return row ?? null;
}

// Every distinct customer paired with the details from their single most recent
// job — feeds a customer-autofill picker on the create form.
export interface CustomerAutofillRecord {
  customer_name: string;
  site_address: string | null;
  insurance_carrier: string | null;
  site_location_id: string | null;
  site_location_label: string | null;
}

export function getCustomersWithLatestJobDetails(): CustomerAutofillRecord[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT j.customer_name, j.site_address, j.insurance_carrier, j.site_location_id,
            l.name AS site_location_label
     FROM jobs j
     LEFT JOIN locations l ON l.id = j.site_location_id
     WHERE j.customer_name IS NOT NULL AND TRIM(j.customer_name) != ''
       AND j.updated_at = (
         SELECT MAX(j2.updated_at) FROM jobs j2
         WHERE LOWER(TRIM(j2.customer_name)) = LOWER(TRIM(j.customer_name))
       )
     GROUP BY LOWER(TRIM(j.customer_name))
     ORDER BY j.customer_name COLLATE NOCASE`,
  );
  return rowsAs<CustomerAutofillRecord>(result.rows);
}

// Whole-row create of a job. Routed through jobsRepo.insert() (local INSERT OR
// REPLACE + outbox INSERT, one payload, no drift) instead of the old app's
// hand-rolled pair. job_number is deliberately OMITTED from the row (not even
// as null): the server's BEFORE INSERT trigger assigns it, and including it
// would let an at-least-once redelivery's ON CONFLICT upsert clobber the
// already-assigned number (churn) — same trap the old app's JobQuickAdd
// comment called out. synced_at (local-only) is also dropped.
export function upsertJob(job: Job): void {
  const typeId = job.type_id ?? (job.type ? resolveTypeId(JOB_CATEGORY, job.type) : null);
  const { synced_at: _syncedAt, job_number: _jobNumber, ...rest } = job;
  jobsRepo.insert({ ...rest, type_id: typeId });
}

/** Return all jobs, optionally including archived ones. Ordered by created_at DESC. */
export function getAllJobs(includeArchived = false): Job[] {
  const db = getDb();
  const sql = includeArchived
    ? `SELECT * FROM jobs ORDER BY created_at DESC`
    : `SELECT * FROM jobs WHERE status != 'archived' ORDER BY created_at DESC`;
  const result = db.executeSync(sql);
  return resolveLabels(rowsAs<Job>(result.rows), 'type_id', 'type');
}

/** Soft-delete a job locally and queue an outbox UPDATE. No self-log — callers
 *  wrap with runInTransaction(() => { archiveJob(id); appendLog({...}) }),
 *  same convention as the rest of this wave's repos (locations.ts, etc). */
export function archiveJob(id: string): void {
  jobsRepo.update({ id, status: 'archived' });
}

const ALLOWED_JOB_UPDATE_FIELDS = new Set<string>([
  'name', 'status', 'customer_name', 'site_address', 'site_location_id',
  'description', 'type', 'reference_number', 'insurance_carrier', 'team_id',
]);

/** Partially update job fields locally and queue an outbox UPDATE. No self-log
 *  (see archiveJob above) — callers wrap with runInTransaction + appendLog. */
export function updateJobFields(
  id: string,
  fields: Partial<Pick<Job,
    'name' | 'status' | 'customer_name' | 'site_address' | 'site_location_id' |
    'description' | 'type' | 'reference_number' | 'insurance_carrier' | 'team_id'>>,
): void {
  const entries = Object.entries(fields).filter(([k]) => ALLOWED_JOB_UPDATE_FIELDS.has(k));
  if (entries.length === 0) return;
  // Dual-write the taxonomy FK (#74) whenever the type label changes.
  if (entries.some(([k]) => k === 'type')) {
    entries.push(['type_id', resolveTypeId(JOB_CATEGORY, (fields as { type?: string | null }).type)]);
  }
  jobsRepo.update({ id, ...Object.fromEntries(entries) });
}

export interface JobDeployments {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  units: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  items: any[];
}

// Return equipment units currently deployed to this job (with item_name), and
// count-based item checkouts from the activity log for this job — the
// derivation for "what's checked out to this job" (there is no checkouts
// table: unit-tracked gear lives on equipment_units.current_job_id, count-based
// items are derived from activity_log's checkout_to_job rows, same split as
// getActiveCheckoutsForUser above).
export function getJobDeployments(jobId: string): JobDeployments {
  const db = getDb();
  const unitsResult = db.executeSync(
    `SELECT eu.*, i.name AS item_name
     FROM equipment_units eu
     JOIN inventory_items i ON i.id = eu.item_id
     WHERE eu.status = 'deployed' AND eu.current_job_id = ?`,
    [jobId],
  );
  const itemsResult = db.executeSync(
    `SELECT al.*, i.name AS item_name, i.unit
     FROM activity_log al
     JOIN inventory_items i ON i.id = al.entity_id
     WHERE al.job_id = ?
       AND al.action = 'checkout_to_job'
       AND i.unit_tracked = 0`,
    [jobId],
  );
  return { units: unitsResult.rows, items: itemsResult.rows };
}

// ── job_assignments (#160, migration 051 / API 063) ────────────────────────
// A job is assigned to a SUBTEAM (crew) — or to an individual user for techs
// without a crew. Crew membership resolves at READ time from
// team_members.subteam_id, so a crew's helpers are automatically included and
// a roster change updates everyone's "My jobs" with no assignment rewrite.
// Unassign is a soft-delete (active = 0, subteams precedent) — rows stay for
// history. Server-side, writes require create_jobs (syncPolicy OPERATION_PERM,
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

// A crew offered by the assign picker: crew name + owning team + lead.
export interface AssignableCrew {
  id: string;
  name: string;
  team_name: string | null;
  lead_name: string | null;
}

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
// belong to (team_members.subteam_id, resolved at read time). Inactive
// assignments and closed/archived jobs are excluded.
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

// Shared insert path for assign(): local row + outbox INSERT (synced_at
// stripped — the server table has no such column) + one activity_log entry,
// atomic. Idempotent on an already-active identical assignment (returns the
// existing id, no new row/outbox/log). Deliberately NOT routed through
// jobAssignmentsRepo.insert() + a caller-owned appendLog (this wave's usual
// no-self-log convention, see archiveJob/updateJobFields above): the
// idempotency check (an existing active row short-circuits the whole write)
// has to run inside the same transaction as the insert, and the assignee's
// display name (resolved by assignJobToCrew/assignJobToUser below) has to be
// available to build the log's `note` — duplicating both at every call site
// would be worse than the one documented deviation here. Ported verbatim from
// apps/mobile/src/db/queries/jobAssignments.ts (assign/unassign self-log this
// same way; see that file's header + jobAssignments.test.ts).
// NOTE activity_log.entity_id is a UUID column server-side — the JOB id goes
// there; the assignee kind/id ride in metadata (the "activitylog_uuid trap").
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
      [id, jobId, kind, assigneeId, actorId, now, now],
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
// transaction). No-op-safe against double-taps: unassigning an already-inactive
// row does nothing (no outbox/log). Self-logs for the same reason assign() does.
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
      [now, assignmentId],
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
