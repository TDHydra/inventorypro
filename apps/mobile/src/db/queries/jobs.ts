import { getDb, rowsAs, bindParams } from '../schema';
import { appendOutbox } from '../../sync/outbox';

export interface Job {
  id: string;
  name: string;
  status: 'open' | 'closed' | 'archived';
  created_by: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
}

export function getOpenJobs(): Job[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM jobs WHERE status = 'open' ORDER BY updated_at DESC`
  );
  return rowsAs<Job>(result.rows);
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
  return rowsAs<Job>(result.rows);
}

export function getJobById(id: string): Job | null {
  const db = getDb();
  const result = db.executeSync(`SELECT * FROM jobs WHERE id = ?`, [id]);
  return (result.rows[0] as unknown as Job) ?? null;
}

export function upsertJob(job: Job): void {
  const db = getDb();
  db.executeSync(
    `INSERT OR REPLACE INTO jobs (id, name, status, created_by, created_at, updated_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    bindParams([job.id, job.name, job.status, job.created_by, job.created_at, job.updated_at, job.synced_at])
  );
}

export function getActiveCheckoutsForUser(userId: string) {
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
  return result.rows;
}

/** Return all jobs, optionally including archived ones. Ordered by created_at DESC. */
export function getAllJobs(includeArchived = false): Job[] {
  const db = getDb();
  const sql = includeArchived
    ? `SELECT * FROM jobs ORDER BY created_at DESC`
    : `SELECT * FROM jobs WHERE status != 'archived' ORDER BY created_at DESC`;
  const result = db.executeSync(sql);
  return rowsAs<Job>(result.rows);
}

/** Soft-delete a job locally and queue an outbox UPDATE. */
export function archiveJob(id: string): void {
  const db = getDb();
  const updated_at = new Date().toISOString();
  db.executeSync(
    `UPDATE jobs SET status = 'archived', updated_at = ? WHERE id = ?`,
    [updated_at, id]
  );
  appendOutbox('UPDATE', 'jobs', { id, status: 'archived', updated_at });
}

/** Partially update job fields locally and queue an outbox UPDATE. */
export function updateJobFields(id: string, fields: { name?: string; status?: string }): void {
  const db = getDb();
  const updated_at = new Date().toISOString();
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (fields.name !== undefined) { sets.push('name = ?'); params.push(fields.name); }
  if (fields.status !== undefined) { sets.push('status = ?'); params.push(fields.status); }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  params.push(updated_at);
  params.push(id);
  db.executeSync(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`, params);
  appendOutbox('UPDATE', 'jobs', { id, ...fields, updated_at });
}

/**
 * Return equipment units currently deployed to this job (with item_name),
 * and count-based item checkouts from the activity log for this job.
 */
export function getJobDeployments(jobId: string): { units: any[]; items: any[] } {
  const db = getDb();
  const unitsResult = db.executeSync(
    `SELECT eu.*, i.name AS item_name
     FROM equipment_units eu
     JOIN inventory_items i ON i.id = eu.item_id
     WHERE eu.status = 'deployed' AND eu.current_job_id = ?`,
    [jobId]
  );
  const itemsResult = db.executeSync(
    `SELECT al.*, i.name AS item_name, i.unit
     FROM activity_log al
     JOIN inventory_items i ON i.id = al.entity_id
     WHERE al.job_id = ?
       AND al.action = 'checkout_to_job'
       AND i.unit_tracked = 0`,
    [jobId]
  );
  return { units: unitsResult.rows, items: itemsResult.rows };
}
