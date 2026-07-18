import { getDb, rowsAs, bindParams } from '../schema';
import { appendOutbox } from '../../sync/outbox';
import { resolveTypeId, resolveLabels, JOB_CATEGORY } from './taxonomy';

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
  // Taxonomy type (migration 011). `type` is the label; `type_id` is the durable
  // FK to taxonomy_types (migration 029, #74) so renames don't orphan the job.
  type?: string | null;
  type_id?: string | null;
  // External reference # — insurance claim / customer PO (migration 013).
  // Distinct from the server-assigned internal job_number; user-supplied.
  reference_number?: string | null;
  // Insurance carrier/company name (migration 016). Distinct from
  // reference_number which holds the claim #/customer PO.
  insurance_carrier?: string | null;
  // Owning team (migration 035 / API 043). NULL means org-wide: visible to
  // everyone. Once set, the scoped pull (routes/sync.ts teamScopeSql) stops
  // returning this job to devices outside that team, and reconcile removes it.
  team_id?: string | null;
}

export function getOpenJobs(): Job[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM jobs WHERE status = 'open' ORDER BY updated_at DESC`
  );
  // Resolve `type` from type_id so a taxonomy rename shows immediately (#74 P2).
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

// Most recent job for a customer (case-insensitive), used to offer cross-fill of
// that customer's usual details. LEFT JOINs the site location so the caller gets a
// ready-to-display label without a second query.
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

// Every distinct customer paired with the details from their single most
// recent job (by updated_at) — feeds `RecordAutofillInput` on the job create
// screen ("pick a previous customer → autofill the rest of the form"),
// generalizing the one-name-at-a-time `getLatestJobByCustomer` above into a
// single query the picker can list up front. Case-insensitive grouping
// mirrors `getLatestJobByCustomer`; the `j.updated_at = MAX(...)` correlated
// subquery narrows to each customer's newest row(s), and the trailing
// `GROUP BY` collapses an exact-timestamp tie down to one row (SQLite picks
// an arbitrary-but-deterministic row per group, same as any other tie-break
// here — there's no "more correct" answer between two rows saved in the same
// instant).
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

export function upsertJob(job: Job): void {
  const db = getDb();
  // Dual-write the taxonomy FK (#74): prefer an explicit type_id (present on rows
  // pulled from the server), else resolve it from the label so locally-created
  // jobs anchor to the taxonomy id too.
  const typeId = job.type_id ?? resolveTypeId(JOB_CATEGORY, job.type);
  db.executeSync(
    `INSERT OR REPLACE INTO jobs
       (id, name, status, created_by, created_at, updated_at, synced_at,
        job_number, customer_name, site_address, site_location_id, description, type, reference_number, insurance_carrier, type_id, team_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindParams([
      job.id, job.name, job.status, job.created_by, job.created_at, job.updated_at, job.synced_at,
      job.job_number ?? null,
      job.customer_name ?? null,
      job.site_address ?? null,
      job.site_location_id ?? null,
      job.description ?? null,
      job.type ?? null,
      job.reference_number ?? null,
      job.insurance_carrier ?? null,
      typeId,
      job.team_id ?? null,
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
  return resolveLabels(rowsAs<Job>(result.rows), 'type_id', 'type');
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
    insurance_carrier?: string | null;
    // NULL = org-wide. Setting it removes the job from non-members' devices on
    // their next sync (scoped pull + reconcile), so the UI confirms the change.
    team_id?: string | null;
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
  // Dual-write the taxonomy FK (#74) whenever the label changes so type_id tracks it.
  let typeId: string | null | undefined;
  if (fields.type !== undefined) {
    typeId = resolveTypeId(JOB_CATEGORY, fields.type);
    sets.push('type = ?'); params.push(fields.type);
    sets.push('type_id = ?'); params.push(typeId);
  }
  if (fields.reference_number !== undefined) { sets.push('reference_number = ?'); params.push(fields.reference_number); }
  if (fields.insurance_carrier !== undefined) { sets.push('insurance_carrier = ?'); params.push(fields.insurance_carrier); }
  if (fields.team_id !== undefined) { sets.push('team_id = ?'); params.push(fields.team_id); }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  params.push(updated_at);
  params.push(id);
  db.executeSync(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`, params);
  appendOutbox('UPDATE', 'jobs', { id, ...fields, ...(fields.type !== undefined ? { type_id: typeId } : {}), updated_at });
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
