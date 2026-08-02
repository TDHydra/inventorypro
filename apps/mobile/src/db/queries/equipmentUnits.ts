import { getDb, rowsAs, bindParams } from '../schema';

export interface EquipmentUnit {
  id: string;
  item_id: string;
  asset_tag: string;
  serial_number: string | null;
  status: string;
  current_location_id: string | null;
  current_job_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  // Lifecycle / depreciation (migration 027). purchase_price & salvage_value are
  // financial — server only pulls them down for view_financial_data holders, so
  // they arrive null on non-financial devices.
  purchase_price: number | null;
  acquired_at: string | null;
  useful_life_months: number | null;
  salvage_value: number | null;
  depreciation_method: string | null;
  next_service_at: string | null;
  service_interval_months: number | null;
  synced_at: string | null;
}

export function getUnitsForItem(itemId: string): EquipmentUnit[] {
  const db = getDb();
  return rowsAs<EquipmentUnit>(db.executeSync(
    `SELECT * FROM equipment_units WHERE item_id = ? ORDER BY asset_tag`, [itemId]).rows);
}

export function getAvailableUnitsAtLocation(itemId: string, locationId: string): EquipmentUnit[] {
  const db = getDb();
  return rowsAs<EquipmentUnit>(db.executeSync(
    `SELECT * FROM equipment_units WHERE item_id = ? AND status = 'available' AND current_location_id = ? ORDER BY asset_tag`,
    [itemId, locationId]).rows);
}

// Point lookup by id — used by the Quick Add "edit just-added unit" sheet to seed
// its form fields (getUnitByTag above is for tag-based dup/lookup checks).
export function getUnitById(id: string): EquipmentUnit | null {
  const db = getDb();
  return (db.executeSync(`SELECT * FROM equipment_units WHERE id = ?`, [id]).rows[0] as unknown as EquipmentUnit) ?? null;
}

export function getUnitByTag(tag: string): EquipmentUnit | null {
  const db = getDb();
  // Case-insensitive: a tag differing only in case is the same physical asset,
  // and dup-checks/scan lookups must not let "am-0007" slip past "AM-0007".
  return (db.executeSync(`SELECT * FROM equipment_units WHERE LOWER(asset_tag) = LOWER(?)`, [tag]).rows[0] as unknown as EquipmentUnit) ?? null;
}

// Typeahead over asset tags (and serial numbers) for pickers. Ranks prefix matches
// first, then shorter tags, then alphabetically — so the closest existing units
// surface as you type. Empty query → no results.
export function searchUnitsByTag(q: string, limit = 12): EquipmentUnit[] {
  const trimmed = q.trim();
  if (!trimmed) return [];
  const db = getDb();
  const like = `%${trimmed}%`;
  const prefix = `${trimmed}%`;
  return rowsAs<EquipmentUnit>(db.executeSync(
    `SELECT * FROM equipment_units
       WHERE asset_tag LIKE ? OR serial_number LIKE ?
       ORDER BY (CASE WHEN asset_tag LIKE ? THEN 0 ELSE 1 END), LENGTH(asset_tag), asset_tag
       LIMIT ?`,
    [like, like, prefix, limit],
  ).rows);
}

export function countUnitsByStatus(itemId: string): { available: number; deployed: number; in_repair: number; retired: number } {
  const db = getDb();
  const rows = db.executeSync(`SELECT status, COUNT(*) AS n FROM equipment_units WHERE item_id = ? GROUP BY status`, [itemId]).rows as { status: string; n: number }[];
  const out = { available: 0, deployed: 0, in_repair: 0, retired: 0 } as Record<string, number>;
  for (const r of rows) out[r.status] = r.n;
  return out as { available: number; deployed: number; in_repair: number; retired: number };
}

export function getDeployedUnitsForUser(userId: string): (EquipmentUnit & { item_name: string; job_name: string | null })[] {
  // Units currently deployed, whose most recent checkout_to_job log was by this user.
  const db = getDb();
  return db.executeSync(
    `SELECT eu.*, i.name AS item_name, j.name AS job_name
     FROM equipment_units eu
     JOIN inventory_items i ON i.id = eu.item_id
     LEFT JOIN jobs j ON j.id = eu.current_job_id
     WHERE eu.status = 'deployed'
       AND EXISTS (
         SELECT 1 FROM activity_log al
         WHERE al.action = 'checkout_to_job'
           AND al.note = 'unit ' || eu.asset_tag
           AND al.user_id = ?
           AND al.job_id = eu.current_job_id
           AND al.created_at = (
             SELECT MAX(al2.created_at) FROM activity_log al2
             WHERE al2.action = 'checkout_to_job' AND al2.note = 'unit ' || eu.asset_tag
           )
       )
     ORDER BY eu.asset_tag`, [userId]).rows as any[];
}

export function upsertUnit(u: EquipmentUnit): void {
  const db = getDb();
  db.executeSync(
    `INSERT OR REPLACE INTO equipment_units
       (id, item_id, asset_tag, serial_number, status, current_location_id, current_job_id, notes, created_at, updated_at, purchase_price, acquired_at, useful_life_months, salvage_value, depreciation_method, next_service_at, service_interval_months, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindParams([u.id, u.item_id, u.asset_tag, u.serial_number, u.status, u.current_location_id, u.current_job_id, u.notes, u.created_at, u.updated_at,
      u.purchase_price ?? null, u.acquired_at ?? null, u.useful_life_months ?? null, u.salvage_value ?? null, u.depreciation_method ?? null, u.next_service_at ?? null, u.service_interval_months ?? null,
      u.synced_at]));
}

export function setUnitStatus(
  unitId: string,
  p: { status: string; current_location_id?: string | null; current_job_id?: string | null; notes?: string | null }
): EquipmentUnit {
  const db = getDb();
  const now = new Date().toISOString();
  const cur = db.executeSync(`SELECT * FROM equipment_units WHERE id = ?`, [unitId]).rows[0] as unknown as EquipmentUnit;
  const next: EquipmentUnit = {
    ...cur, status: p.status,
    current_location_id: p.current_location_id !== undefined ? p.current_location_id : cur.current_location_id,
    current_job_id: p.current_job_id !== undefined ? p.current_job_id : cur.current_job_id,
    notes: p.notes !== undefined ? p.notes : cur.notes,
    updated_at: now, synced_at: null,
  };
  upsertUnit(next);
  return next;
}

// #212 close-out guard: what would be stranded if these jobs were closed right
// now — units still deployed to them, and open (completed_at IS NULL, matching
// getRepairs({done:false})) repairs on those units. One aggregate query pair so
// the jobs screens can gate doClose/saveEdit with a single cheap call.
export function getCloseoutBlockers(jobIds: string[]): { deployedUnits: number; openRepairs: number } {
  if (jobIds.length === 0) return { deployedUnits: 0, openRepairs: 0 };
  const db = getDb();
  const placeholders = jobIds.map(() => '?').join(',');
  const deployedUnits = ((db.executeSync(
    `SELECT COUNT(*) AS cnt FROM equipment_units WHERE current_job_id IN (${placeholders})`,
    [...jobIds]
  ).rows[0] as { cnt: number } | undefined)?.cnt) ?? 0;
  const openRepairs = ((db.executeSync(
    `SELECT COUNT(*) AS cnt FROM repairs r
     JOIN equipment_units eu ON r.entity_type = 'equipment_unit' AND r.entity_id = eu.id
     WHERE eu.current_job_id IN (${placeholders}) AND r.completed_at IS NULL`,
    [...jobIds]
  ).rows[0] as { cnt: number } | undefined)?.cnt) ?? 0;
  return { deployedUnits, openRepairs };
}

// #223: the recovery view of the #212 gap — units still pointing at a job
// that has since been closed (via "close anyway" or a close from another
// device). Deployed-only: retired/in_repair units keep their job pointer as
// history and aren't recoverable field gear.
export function getUnitsStrandedOnClosedJobs(): (EquipmentUnit & { item_name: string; job_name: string; job_number: number | null })[] {
  const db = getDb();
  return db.executeSync(
    `SELECT eu.*, i.name AS item_name, j.name AS job_name, j.job_number
     FROM equipment_units eu
     JOIN inventory_items i ON i.id = eu.item_id
     JOIN jobs j ON j.id = eu.current_job_id
     WHERE eu.status = 'deployed' AND j.status = 'closed'
     ORDER BY j.updated_at DESC, eu.asset_tag`
  ).rows as any[];
}

// #212: human copy for the guard's ConfirmSheet — zero buckets are omitted.
export function describeCloseoutBlockers(b: { deployedUnits: number; openRepairs: number }): string {
  const parts: string[] = [];
  if (b.deployedUnits > 0) parts.push(`${b.deployedUnits} unit${b.deployedUnits === 1 ? '' : 's'} still checked out`);
  if (b.openRepairs > 0) parts.push(`${b.openRepairs} open repair${b.openRepairs === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
