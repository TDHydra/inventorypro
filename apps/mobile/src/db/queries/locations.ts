import { getDb, rowsAs, bindParams } from '../schema';
import { appendOutbox } from '../../sync/outbox';
import { generateUUID } from '../../utils/uuid';
import { runInTransaction } from '../tx';
import { appendLog } from './log';

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
  // When 1, add-stock offers a Shelf field (migration 020). INTEGER locally.
  has_shelves?: number;
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

// "Real" browsable locations — everything EXCEPT shelves (type='Shelf'). Shelves
// are a sub-level of a has_shelves location (created via findOrCreateShelf), not
// first-class locations: they're excluded from the Locations browser tree/list
// and from parent choices (a shelf can't itself contain sub-areas). The
// item-assign two-stage pickers (ItemQuickAdd, inventory/add) intentionally keep
// using getAllLocations() so shelves stay reachable there.
export function getBrowsableLocations(): Location[] {
  return getAllLocations().filter(l => l.type !== 'Shelf');
}

export interface LocationShelfPick {
  location: { id: string; label: string } | null;
  shelf: { id: string; label: string } | null;
}

/**
 * Resolve a stored location id (which may be a shelf — a child of a shelf-bearing
 * location) into a (location, shelf) pair for the two-stage picker. If the id is a
 * shelf, returns its parent as the location and itself as the shelf; otherwise the
 * location with no shelf. Unknown/null id → both null. Used to seed the main-storage
 * default in Quick Add and the main-storage setting in admin.
 */
export function resolveLocationShelf(locationId: string | null): LocationShelfPick {
  if (!locationId) return { location: null, shelf: null };
  const byId = new Map(getAllLocations().map(l => [l.id, l]));
  const loc = byId.get(locationId);
  if (!loc) return { location: null, shelf: null };
  const parent = loc.parent_id ? byId.get(loc.parent_id) : undefined;
  if (parent && parent.has_shelves === 1) {
    return {
      location: { id: parent.id, label: parent.name },
      shelf: { id: loc.id, label: loc.name },
    };
  }
  return { location: { id: loc.id, label: loc.name }, shelf: null };
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
  // Shelves are excluded so the Locations browser tree only shows real
  // locations — see getBrowsableLocations(). Since nothing in the UI lets a
  // shelf be chosen as a parent (the "Inside" pickers use getBrowsableLocations
  // too), no non-shelf location is ever parented under a shelf, so this filter
  // can't orphan a real sub-area out of the tree.
  const all = getBrowsableLocations();
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

// Active locations whose name matches the query (case-insensitive), for global search.
export function searchLocations(q: string, limit = 20): Location[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM locations WHERE active = 1 AND name LIKE ? ORDER BY name LIMIT ?`,
    [`%${q}%`, limit],
  );
  return rowsAs<Location>(result.rows);
}

// "Office" destinations — locations tagged Shop or Office (the franchise base).
// Backs the scan check-out flow's Office quick-destination.
export function getOfficeLocations(): Location[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM locations WHERE active = 1 AND type IN ('Shop', 'Office') ORDER BY name`,
  );
  return rowsAs<Location>(result.rows);
}

// Shelf child-locations of a given parent, for the add-stock Shelf typeahead.
export function getShelvesForParent(parentId: string): Location[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM locations WHERE active = 1 AND type = 'Shelf' AND parent_id = ? ORDER BY name`,
    [parentId],
  );
  return rowsAs<Location>(result.rows);
}

// Find (case-insensitive) or create a Shelf child of `parentId` named `name`,
// returning its location id. Newly created shelves are written locally + queued
// to the sync outbox (real boolean for active/has_shelves). Stock is then tracked
// against the returned shelf location id.
//
// CONTRACT: returns null if the shelf could NOT be created (the upsert + outbox
// writes are wrapped in one transaction and we swallow the error here rather than
// throw). Callers MUST null-check and surface a "couldn't create shelf" message
// instead of tracking stock against a missing location. (An empty name returns
// the parent id unchanged, which is a valid location.)
export function findOrCreateShelf(parentId: string, name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return parentId;
  const db = getDb();
  const existing = rowsAs<Location>(db.executeSync(
    `SELECT * FROM locations WHERE active = 1 AND type = 'Shelf' AND parent_id = ?
       AND LOWER(name) = LOWER(?) LIMIT 1`,
    [parentId, trimmed],
  ).rows)[0];
  if (existing) return existing.id;

  const id = generateUUID();
  const now = new Date().toISOString();
  const shelf: Location = {
    id, name: trimmed, parent_id: parentId, color: null, icon: '🗄️',
    owner_user_id: null, active: 1, updated_at: now, synced_at: null,
    latitude: null, longitude: null, subareas_require_owner: 0, type: 'Shelf', has_shelves: 0,
  };
  try {
    // upsertLocation + appendOutbox are two writes — keep them atomic so we never
    // create a local shelf the server won't hear about (or vice-versa).
    runInTransaction(() => {
      upsertLocation(shelf);
      appendOutbox('INSERT', 'locations', {
        id, name: trimmed, parent_id: parentId, color: null, icon: '🗄️',
        owner_user_id: null, active: true, updated_at: now,
        latitude: null, longitude: null, subareas_require_owner: false, type: 'Shelf', has_shelves: false,
      });
    });
  } catch (err) {
    console.warn('findOrCreateShelf: failed to create shelf', err);
    return null;
  }
  return id;
}

// Set (or clear, with null) a shelf's optional display color — reuses the same
// locations.color column a regular location's edit form writes, so a shelf can
// carry a color without a schema change. Mirrors the location edit screen's
// upsert + outbox + log pattern (kept as its own small setter rather than a full
// upsertLocation call so callers touching just the color don't need every other
// location field). No-ops on an unknown id or a non-Shelf location.
export function setShelfColor(shelfId: string, color: string | null, userId: string | null): void {
  const shelf = getLocationById(shelfId);
  if (!shelf || shelf.type !== 'Shelf') return;
  const now = new Date().toISOString();
  try {
    runInTransaction(() => {
      getDb().executeSync(
        `UPDATE locations SET color = ?, updated_at = ? WHERE id = ?`,
        [color, now, shelfId],
      );
      appendOutbox('UPDATE', 'locations', { id: shelfId, color, updated_at: now });
      appendLog({
        action: 'location_updated',
        entity_type: 'location',
        entity_id: shelfId,
        user_id: userId,
        team_id: null,
        job_id: null,
        note: shelf.name,
        from_location_id: null,
        to_location_id: null,
        quantity: null,
        unit: null,
        metadata: null,
        device_id: null,
      });
    });
  } catch (err) {
    console.warn('setShelfColor: failed to set shelf color', err);
  }
}

// Find (case-insensitive, across any parent) or create a Shelf location by name,
// returning its id. Used by the item "Home location" typeahead where there's no
// pre-selected parent — shelves are identified by their prefixed name (WH-A1),
// so a new one is created top-level (parent_id null) and can be re-parented later.
//
// CONTRACT: returns null for an empty name OR if the create failed (the upsert +
// outbox writes are wrapped in one transaction and the error is swallowed here
// rather than thrown). Callers MUST null-check before using the id.
export function findOrCreateShelfByName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const db = getDb();
  const existing = rowsAs<Location>(db.executeSync(
    `SELECT * FROM locations WHERE active = 1 AND type = 'Shelf' AND LOWER(name) = LOWER(?) LIMIT 1`,
    [trimmed],
  ).rows)[0];
  if (existing) return existing.id;

  const id = generateUUID();
  const now = new Date().toISOString();
  const shelf: Location = {
    id, name: trimmed, parent_id: null, color: null, icon: '🗄️',
    owner_user_id: null, active: 1, updated_at: now, synced_at: null,
    latitude: null, longitude: null, subareas_require_owner: 0, type: 'Shelf', has_shelves: 0,
  };
  try {
    // Keep the local upsert and the outbox enqueue atomic — partial state here
    // means a shelf that either never syncs or exists only in the outbox.
    runInTransaction(() => {
      upsertLocation(shelf);
      appendOutbox('INSERT', 'locations', {
        id, name: trimmed, parent_id: null, color: null, icon: '🗄️',
        owner_user_id: null, active: true, updated_at: now,
        latitude: null, longitude: null, subareas_require_owner: false, type: 'Shelf', has_shelves: false,
      });
    });
  } catch (err) {
    console.warn('findOrCreateShelfByName: failed to create shelf', err);
    return null;
  }
  return id;
}

// Find (case-insensitive) or create a Vehicle location by name, returning its id.
// Mirrors findOrCreateShelfByName but for type 'Vehicle' — backs the inline
// "+ Create" affordance in the repair Vehicle picker (a vehicle is just a location
// tagged type='Vehicle'; owner can be set later from the location screen).
export function findOrCreateVehicleByName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const db = getDb();
  const existing = rowsAs<Location>(db.executeSync(
    `SELECT * FROM locations WHERE active = 1 AND type = 'Vehicle' AND LOWER(name) = LOWER(?) LIMIT 1`,
    [trimmed],
  ).rows)[0];
  if (existing) return existing.id;

  const id = generateUUID();
  const now = new Date().toISOString();
  const vehicle: Location = {
    id, name: trimmed, parent_id: null, color: null, icon: '🚐',
    owner_user_id: null, active: 1, updated_at: now, synced_at: null,
    latitude: null, longitude: null, subareas_require_owner: 0, type: 'Vehicle', has_shelves: 0,
  };
  upsertLocation(vehicle);
  appendOutbox('INSERT', 'locations', {
    id, name: trimmed, parent_id: null, color: null, icon: '🚐',
    owner_user_id: null, active: true, updated_at: now,
    latitude: null, longitude: null, subareas_require_owner: false, type: 'Vehicle', has_shelves: false,
  });
  return id;
}

export function upsertLocation(location: Location): void {
  const db = getDb();
  db.executeSync(
    `INSERT OR REPLACE INTO locations (id, name, parent_id, color, icon, owner_user_id, active, updated_at, synced_at, latitude, longitude, subareas_require_owner, type, has_shelves)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindParams([location.id, location.name, location.parent_id, location.color,
     location.icon, location.owner_user_id, location.active, location.updated_at, location.synced_at,
     location.latitude ?? null, location.longitude ?? null, location.subareas_require_owner ?? 0,
     location.type ?? null, location.has_shelves ?? 0])
  );
}
