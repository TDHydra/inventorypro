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
  // Per-parent gate (migration 012). When 1, child locations under this parent
  // require an owner. INTEGER locally; optional so existing literals stay valid,
  // upsertLocation coalesces undefined → 0.
  subareas_require_owner?: number;
  // location_type taxonomy label (migration 017): Shop, Vehicle, Locker, … Optional
  // so existing literals stay valid; upsertLocation coalesces undefined → null.
  type?: string | null;
}

export interface LocationWithChildren extends Location {
  children: LocationWithChildren[];
  depth: number;
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

// Full recursive tree (arbitrary depth). `depth` is the 0-based nesting level,
// for indentation. A visited set guards against any cyclic parent_id data so the
// recursion can't loop forever.
export function getLocationTree(): LocationWithChildren[] {
  const all = getAllLocations();
  const byParent = new Map<string | null, Location[]>();
  for (const loc of all) {
    const key = loc.parent_id ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(loc);
  }
  const build = (loc: Location, depth: number, seen: Set<string>): LocationWithChildren => {
    seen.add(loc.id);
    const kids = (byParent.get(loc.id) ?? []).filter(c => !seen.has(c.id));
    return { ...loc, depth, children: kids.map(c => build(c, depth + 1, seen)) };
  };
  return (byParent.get(null) ?? []).map(loc => build(loc, 0, new Set()));
}

// Ancestor path as "Top › Mid › Leaf" (the location itself last). Walks parent_id
// up via the in-memory set; cycle-guarded.
export function getLocationPath(id: string, sep = ' › '): string {
  const all = getAllLocations();
  const byId = new Map(all.map(l => [l.id, l]));
  const names: string[] = [];
  const seen = new Set<string>();
  let cur = byId.get(id) ?? null;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    names.unshift(cur.name);
    cur = cur.parent_id ? byId.get(cur.parent_id) ?? null : null;
  }
  return names.join(sep);
}

// IDs of a location plus all its descendants — used to exclude invalid parent
// choices (can't re-parent a location under itself or one of its descendants).
export function getDescendantIds(id: string): Set<string> {
  const all = getAllLocations();
  const byParent = new Map<string | null, Location[]>();
  for (const loc of all) {
    const key = loc.parent_id ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(loc);
  }
  const out = new Set<string>([id]);
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const c of byParent.get(cur) ?? []) {
      if (!out.has(c.id)) { out.add(c.id); stack.push(c.id); }
    }
  }
  return out;
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

// Active "Shelf"-type locations, for the item Home-location typeahead. Shelves
// are entered with prefixes (e.g. WH-A1, SHOP-B3), so name order is enough.
export function getShelfLocations(): Location[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM locations WHERE active = 1 AND type = 'Shelf' ORDER BY name`,
  );
  return rowsAs<Location>(result.rows);
}

export function upsertLocation(location: Location): void {
  const db = getDb();
  db.executeSync(
    `INSERT OR REPLACE INTO locations (id, name, parent_id, color, icon, owner_user_id, active, updated_at, synced_at, latitude, longitude, subareas_require_owner, type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindParams([location.id, location.name, location.parent_id, location.color,
     location.icon, location.owner_user_id, location.active, location.updated_at, location.synced_at,
     location.latitude ?? null, location.longitude ?? null, location.subareas_require_owner ?? 0,
     location.type ?? null])
  );
}
