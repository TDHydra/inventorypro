import { getDb, rowsAs, bindParams } from '../schema';

export interface Location {
  id: string;
  name: string;
  parent_id: string | null;
  color: string | null;
  icon: string | null;
  owner_user_id: string | null;
  active: number;
  updated_at: string;
  synced_at: string | null;
  // Coords (migration 009). Optional so existing Location literals stay valid;
  // upsertLocation coalesces undefined → null. Set via "use my current spot".
  latitude?: number | null;
  longitude?: number | null;
}

export interface LocationWithChildren extends Location {
  children: Location[];
}

export function getAllLocations(): Location[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM locations WHERE active = 1 ORDER BY parent_id NULLS FIRST, name`
  );
  return rowsAs<Location>(result.rows);
}

export function getTopLevelLocations(): Location[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM locations WHERE parent_id IS NULL AND active = 1 ORDER BY name`
  );
  return rowsAs<Location>(result.rows);
}

export function getSubAreas(parentId: string): Location[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM locations WHERE parent_id = ? AND active = 1 ORDER BY name`,
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

// Locations that belong to a user (a PM's locker/vehicle, etc.).
export function getLocationsByOwner(ownerUserId: string): Location[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM locations WHERE owner_user_id = ? AND active = 1 ORDER BY name`,
    [ownerUserId]
  );
  return rowsAs<Location>(result.rows);
}

export interface StockAtLocation {
  item_id: string;
  location_id: string;
  quantity: number;
  updated_at: string;
  name: string;
}

export function getStockAtLocation(locationId: string): StockAtLocation[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT s.item_id, s.location_id, s.quantity, s.updated_at, i.name
     FROM stock_by_location s
     JOIN inventory_items i ON i.id = s.item_id
     WHERE s.location_id = ? AND i.active = 1 AND s.quantity > 0
     ORDER BY i.name`,
    [locationId]
  );
  return rowsAs<StockAtLocation>(result.rows);
}

export function upsertLocation(location: Location): void {
  const db = getDb();
  db.executeSync(
    `INSERT OR REPLACE INTO locations (id, name, parent_id, color, icon, owner_user_id, active, updated_at, synced_at, latitude, longitude)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindParams([location.id, location.name, location.parent_id, location.color,
     location.icon, location.owner_user_id, location.active, location.updated_at, location.synced_at,
     location.latitude ?? null, location.longitude ?? null])
  );
}
