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
  // Work-order fields (migration 008). Optional so existing Job literals stay
  // valid; job_number is assigned server-side on insert when left null.
  job_number?: string | null;
  customer_name?: string | null;
  site_address?: string | null;
  site_location_id?: string | null;
  description?: string | null;
  // Taxonomy type (migration 011).
  type?: string | null;
  // External reference # — insurance claim / customer PO (migration 013).
  // Distinct from the server-assigned internal job_number; user-supplied.
  reference_number?: string | null;
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
    `INSERT OR REPLACE INTO jobs
       (id, name, status, created_by, created_at, updated_at, synced_at,
        job_number, customer_name, site_address, site_location_id, description, type, reference_number)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindParams([
      job.id, job.name, job.status, job.created_by, job.created_at, job.updated_at, job.synced_at,
      job.job_number ?? null,
      job.customer_name ?? null,
      job.site_address ?? null,
      job.site_location_id ?? null,
      job.description ?? null,
      job.type ?? null,
      job.reference_number ?? null,
    ])
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
export function updateJobFields(
  id: string,
  fields: {
    name?: string;
    status?: string;
    job_number?: string | null;
    customer_name?: string | null;
    site_address?: string | null;
    site_location_id?: string | null;
    description?: string | null;
    type?: string | null;
    reference_number?: string | null;
  }
): void {
  const db = getDb();
  const updated_at = new Date().toISOString();
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (fields.name !== undefined) { sets.push('name = ?'); params.push(fields.name); }
  if (fields.status !== undefined) { sets.push('status = ?'); params.push(fields.status); }
  if (fields.job_number !== undefined) { sets.push('job_number = ?'); params.push(fields.job_number); }
  if (fields.customer_name !== undefined) { sets.push('customer_name = ?'); params.push(fields.customer_name); }
  if (fields.site_address !== undefined) { sets.push('site_address = ?'); params.push(fields.site_address); }
  if (fields.site_location_id !== undefined) { sets.push('site_location_id = ?'); params.push(fields.site_location_id); }
  if (fields.description !== undefined) { sets.push('description = ?'); params.push(fields.description); }
  if (fields.type !== undefined) { sets.push('type = ?'); params.push(fields.type); }
  if (fields.reference_number !== undefined) { sets.push('reference_number = ?'); params.push(fields.reference_number); }
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
