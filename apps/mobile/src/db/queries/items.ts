import { getDb, rowsAs, bindParams } from '../schema';

export interface InventoryItem {
  id: string;
  name: string;
  barcode: string | null;
  description: string | null;
  sku: string | null;
  supplier: string | null;
  model: string | null;
  kind: string; // 'product' | 'equipment'
  category: string | null;
  returnable: number;
  unit_tracked: number;
  tag_prefix: string | null;
  unit_category: string;
  unit: string;
  min_qty_alert: number;
  reorder_to: number | null;
  active: number;
  updated_at: string;
  synced_at: string | null;
}

export interface ItemWithTotalStock extends InventoryItem {
  total_stock: number;
}

export interface StockByLocation {
  location_id: string;
  location_name: string;
  parent_id: string | null;
  parent_name: string | null;
  quantity: number;
}

export function searchItems(
  query: string,
  limit = 20,
  offset = 0,
  category?: string
): ItemWithTotalStock[] {
  const db = getDb();
  const pattern = `%${query}%`;
  const catClause = category ? `AND i.unit_category = ?` : '';
  const params: (string | number)[] = [pattern, pattern, pattern, query, `${query}%`];
  if (category) params.push(category);
  params.push(limit, offset);

  const result = db.executeSync(
    `SELECT i.*,
            CASE WHEN i.unit_tracked = 1
                 THEN (SELECT COUNT(*) FROM equipment_units eu
                       WHERE eu.item_id = i.id AND eu.status = 'available')
                 ELSE COALESCE(SUM(s.quantity), 0) END AS total_stock
     FROM inventory_items i
     LEFT JOIN stock_by_location s ON s.item_id = i.id
     WHERE i.active = 1
       AND (i.name LIKE ? OR i.barcode LIKE ? OR i.description LIKE ?)
       ${catClause}
     GROUP BY i.id
     ORDER BY
       CASE WHEN LOWER(i.name) = LOWER(?) THEN 0
            WHEN LOWER(i.name) LIKE LOWER(?) THEN 1
            ELSE 2 END,
       i.name
     LIMIT ? OFFSET ?`,
    params
  );
  return rowsAs<ItemWithTotalStock>(result.rows);
}

export function getItemByBarcode(barcode: string): InventoryItem | null {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM inventory_items WHERE barcode = ? AND active = 1`,
    [barcode]
  );
  return (result.rows[0] as unknown as InventoryItem) ?? null;
}

export function getItemById(id: string): InventoryItem | null {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM inventory_items WHERE id = ?`,
    [id]
  );
  return (result.rows[0] as unknown as InventoryItem) ?? null;
}

export function getStockByItem(itemId: string): StockByLocation[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT s.location_id,
            l.name AS location_name,
            l.parent_id,
            p.name AS parent_name,
            s.quantity
     FROM stock_by_location s
     JOIN locations l ON l.id = s.location_id
     LEFT JOIN locations p ON p.id = l.parent_id
     WHERE s.item_id = ?
     ORDER BY p.name NULLS LAST, l.name`,
    [itemId]
  );
  return rowsAs<StockByLocation>(result.rows);
}

export function upsertItem(item: InventoryItem): void {
  const db = getDb();
  db.executeSync(
    `INSERT OR REPLACE INTO inventory_items
       (id, name, barcode, description, sku, supplier, model, kind,
        category, returnable, unit_tracked, tag_prefix,
        unit_category, unit, min_qty_alert, reorder_to, active, updated_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindParams([item.id, item.name, item.barcode, item.description,
     item.sku, item.supplier, item.model, item.kind,
     item.category, item.returnable, item.unit_tracked, item.tag_prefix,
     item.unit_category, item.unit, item.min_qty_alert, item.reorder_to,
     item.active, item.updated_at, item.synced_at])
  );
}

// Partial edit of catalog fields (not stock). Returns the column/value map that
// should also go to the sync outbox so callers stay in sync with the server.
export function updateItemFields(
  id: string,
  fields: Partial<Pick<InventoryItem,
    'name' | 'barcode' | 'description' | 'sku' | 'supplier' | 'model' |
    'category' | 'returnable' | 'unit_tracked' | 'tag_prefix' |
    'unit_category' | 'unit' | 'min_qty_alert' | 'reorder_to'>>
): Record<string, unknown> {
  const db = getDb();
  const now = new Date().toISOString();
  const entries = Object.entries(fields);
  const setClause = entries.map(([k]) => `${k} = ?`).join(', ');
  db.executeSync(
    `UPDATE inventory_items SET ${setClause}, updated_at = ? WHERE id = ?`,
    bindParams([...entries.map(([, v]) => v), now, id])
  );
  return { id, ...fields, updated_at: now };
}

export function upsertStock(item: { item_id: string; location_id: string; quantity: number; updated_at?: string }, locationId?: string, quantity?: number): void {
  // Support both (item_row) and legacy (itemId, locationId, qty) call styles
  const itemId = typeof item === 'object' ? item.item_id : item;
  const locId = typeof item === 'object' ? item.location_id : (locationId ?? '');
  const qty = typeof item === 'object' ? item.quantity : (quantity ?? 0);
  return _upsertStock(itemId, locId, qty);
}

function _upsertStock(itemId: string, locationId: string, quantity: number): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.executeSync(
    `INSERT OR REPLACE INTO stock_by_location (item_id, location_id, quantity, updated_at)
     VALUES (?, ?, ?, ?)`,
    [itemId, locationId, quantity, now]
  );
}

// Alias kept for direct (id, locationId, qty) callers
export { _upsertStock as upsertStockRaw };

// Distinct existing values for a column, for autocomplete suggestions. Column is
// a fixed whitelist (no injection). Lets crews reuse "Phoenix Supply" instead of
// retyping it five slightly-different ways.
export function getDistinctValues(column: 'supplier' | 'model' | 'unit' | 'category'): string[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT DISTINCT ${column} AS v FROM inventory_items
     WHERE ${column} IS NOT NULL AND TRIM(${column}) != '' ORDER BY v COLLATE NOCASE`
  );
  return (result.rows as { v: string }[]).map(r => r.v);
}

// Current on-hand quantity for an (item, location), 0 if no row exists.
export function getStockQuantity(itemId: string, locationId: string): number {
  const db = getDb();
  const result = db.executeSync(
    `SELECT quantity FROM stock_by_location WHERE item_id = ? AND location_id = ?`,
    [itemId, locationId]
  );
  return (result.rows[0] as { quantity: number } | undefined)?.quantity ?? 0;
}

export function adjustStock(itemId: string, locationId: string, delta: number): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.executeSync(
    `INSERT INTO stock_by_location (item_id, location_id, quantity, updated_at)
     VALUES (?, ?, MAX(0, ?), ?)
     ON CONFLICT(item_id, location_id) DO UPDATE SET
       quantity = MAX(0, quantity + excluded.quantity - ?),
       updated_at = excluded.updated_at`,
    [itemId, locationId, delta, now, 0]
  );
}

export function getLowStockItems(): ItemWithTotalStock[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM (
       SELECT i.*,
              CASE WHEN i.unit_tracked = 1
                   THEN (SELECT COUNT(*) FROM equipment_units eu
                         WHERE eu.item_id = i.id AND eu.status = 'available')
                   ELSE COALESCE(SUM(s.quantity), 0) END AS total_stock
       FROM inventory_items i
       LEFT JOIN stock_by_location s ON s.item_id = i.id
       WHERE i.active = 1 AND i.min_qty_alert > 0
       GROUP BY i.id
     )
     WHERE total_stock <= min_qty_alert
     ORDER BY total_stock ASC`
  );
  return rowsAs<ItemWithTotalStock>(result.rows);
}
