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
       (id, item_id, asset_tag, serial_number, status, current_location_id, current_job_id, notes, created_at, updated_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindParams([u.id, u.item_id, u.asset_tag, u.serial_number, u.status, u.current_location_id, u.current_job_id, u.notes, u.created_at, u.updated_at, u.synced_at]));
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
