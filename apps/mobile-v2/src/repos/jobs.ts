import { getDb, rowsAs } from '../db/schema';
import { resolveLabels } from './taxonomy';

// Wave A stub: READ-ONLY subset of the jobs domain, just enough for global
// search and pickers. The full jobs repo (upsertJob, archiveJob,
// updateJobFields, deployments, checkouts) lands in Wave C with the jobs
// surfaces — add writes there via createRepository('jobs'), not here.

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
