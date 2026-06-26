import { getDb, rowsAs, bindParams } from '../schema';

export interface Location {
  id: string;
  name: string;
  parent_id: string | null;
  color: string | null;
  icon: string | null;
  owner_user_id: string | null;
  updated_at: string;
  synced_at: string | null;
}

export interface LocationWithChildren extends Location {
  children: Location[];
}

export function getAllLocations(): Location[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM locations ORDER BY parent_id NULLS FIRST, name`
  );
  return rowsAs<Location>(result.rows);
}

export function getTopLevelLocations(): Location[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM locations WHERE parent_id IS NULL ORDER BY name`
  );
  return rowsAs<Location>(result.rows);
}

export function getSubAreas(parentId: string): Location[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM locations WHERE parent_id = ? ORDER BY name`,
    [parentId]
  );
  return rowsAs<Location>(result.rows);
}

export function getLocationTree(): LocationWithChildren[] {
  const all = getAllLocations();
  const byParent = new Map<string | null, Location[]>();
  for (const loc of all) {
    const key = loc.parent_id ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(loc);
  }
  return (byParent.get(null) ?? []).map(loc => ({
    ...loc,
    children: byParent.get(loc.id) ?? [],
  }));
}

export function getLocationById(id: string): Location | null {
  const db = getDb();
  const result = db.executeSync(`SELECT * FROM locations WHERE id = ?`, [id]);
  return (result.rows[0] as unknown as Location) ?? null;
}

export function upsertLocation(location: Location): void {
  const db = getDb();
  db.executeSync(
    `INSERT OR REPLACE INTO locations (id, name, parent_id, color, icon, owner_user_id, updated_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    bindParams([location.id, location.name, location.parent_id, location.color,
     location.icon, location.owner_user_id, location.updated_at, location.synced_at])
  );
}
