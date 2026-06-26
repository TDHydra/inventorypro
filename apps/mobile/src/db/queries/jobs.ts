import { getDb, rowsAs, bindParams } from '../schema';

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
     ORDER BY al.created_at DESC`,
    [userId]
  );
  return result.rows;
}
