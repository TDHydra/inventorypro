import { getDb, rowsAs, bindParams } from '../schema';
import { appendOutbox } from '../../sync/outbox';
import { generateUUID } from '../../utils/uuid';

export type TaxonomyType = {
  id: string;
  category: string;
  label: string;
  icon: string | null;
  sort_order: number;
  active: number;
  updated_at: string;
  meta: string | null;
};

// A product_class taxonomy row with its `meta` JSON parsed into curated units +
// decimals policy. `meta` is added by migration 012 (assumed present at runtime).
export type ProductClass = {
  id: string;
  label: string;
  icon: string | null;
  units: string[];
  allowDecimals: boolean;
  active: number;
  sort_order: number;
};

const PRODUCT_CLASS_CATEGORY = 'product_class';
export const ITEM_CATEGORY = 'item_category';

// item_category.meta shape (migration 018): the type's curated units + the
// product_class it maps to (stored as the item's unit_category for formatting).
export type ItemTypeMeta = { units: string[]; classId: string | null };

export function parseItemTypeMeta(meta: string | null | undefined): ItemTypeMeta {
  if (!meta) return { units: [], classId: null };
  try {
    const p = JSON.parse(meta) as { units?: unknown; classId?: unknown };
    return {
      units: Array.isArray(p.units) ? p.units.filter((u): u is string => typeof u === 'string') : [],
      classId: typeof p.classId === 'string' ? p.classId : null,
    };
  } catch {
    return { units: [], classId: null };
  }
}

// Active item types (PPE, Filters, …) for the catalog forms.
export function getItemTypes(opts?: { includeInactive?: boolean }): TaxonomyType[] {
  return getTaxonomyTypes(ITEM_CATEGORY, opts);
}

export const LOCATION_TYPE = 'location_type';

// Active location types (Shop, Vehicle, Locker, Maintenance, …) for the location
// forms + section filters.
export function getLocationTypes(opts?: { includeInactive?: boolean }): TaxonomyType[] {
  return getTaxonomyTypes(LOCATION_TYPE, opts);
}

// Per-location-type form rules (migration 022). gps defaults TRUE (show the GPS
// anchor) and requiresOwner FALSE for unflagged/custom types.
export type LocationTypeRules = { gps: boolean; requiresOwner: boolean };
export function parseLocationTypeMeta(meta: string | null | undefined): LocationTypeRules {
  const rules: LocationTypeRules = { gps: true, requiresOwner: false };
  if (!meta) return rules;
  try {
    const p = JSON.parse(meta) as { gps?: unknown; requiresOwner?: unknown };
    if (typeof p.gps === 'boolean') rules.gps = p.gps;
    if (typeof p.requiresOwner === 'boolean') rules.requiresOwner = p.requiresOwner;
  } catch { /* keep defaults */ }
  return rules;
}
// Rules for a location type by its label (for the location form).
export function getLocationTypeRules(label: string | null | undefined): LocationTypeRules {
  if (!label) return { gps: true, requiresOwner: false };
  const row = getTaxonomyTypes(LOCATION_TYPE, { includeInactive: true }).find(t => t.label === label);
  return parseLocationTypeMeta(row?.meta);
}

export const REPAIR_STATUS = 'repair_status';

// Admin-editable repair statuses (Open, Awaiting Parts, In Progress, Repaired, …).
export function getRepairStatuses(opts?: { includeInactive?: boolean }): TaxonomyType[] {
  return getTaxonomyTypes(REPAIR_STATUS, opts);
}

// Whether a repair_status label "counts as completed" (meta.terminal). Unknown
// labels are treated as non-terminal.
export function isTerminalStatus(label: string): boolean {
  const row = getTaxonomyTypes(REPAIR_STATUS, { includeInactive: true }).find(t => t.label === label);
  if (!row?.meta) return false;
  try { return (JSON.parse(row.meta) as { terminal?: unknown }).terminal === true; } catch { return false; }
}

// Set ONLY the terminal flag inside a repair_status row's meta (preserves any
// other meta keys), + outbox — mirrors setTaxonomyClassId.
export function setTaxonomyTerminal(id: string, terminal: boolean): void {
  const db = getDb();
  const existing = rowsAs<TaxonomyType>(
    db.executeSync(`SELECT * FROM taxonomy_types WHERE id = ? LIMIT 1`, [id]).rows,
  )[0];
  if (!existing) return;
  let meta: Record<string, unknown> = {};
  try { meta = existing.meta ? (JSON.parse(existing.meta) as Record<string, unknown>) : {}; } catch { meta = {}; }
  meta.terminal = terminal;
  const metaStr = JSON.stringify(meta);
  const updated_at = new Date().toISOString();
  db.executeSync(
    `INSERT OR REPLACE INTO taxonomy_types (id, category, label, icon, sort_order, active, updated_at, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    bindParams([existing.id, existing.category, existing.label, existing.icon, existing.sort_order, existing.active, updated_at, metaStr]),
  );
  appendOutbox('INSERT', 'taxonomy_types', {
    id: existing.id, category: existing.category, label: existing.label, icon: existing.icon,
    sort_order: existing.sort_order, active: existing.active === 1, updated_at, meta: metaStr,
  });
}

// Update ONLY the `units` array inside a taxonomy row's meta, preserving every
// other meta key (e.g. item_category's classId). Used by the Manage Types units
// editor for item types so editing units doesn't wipe the class mapping.
export function setTaxonomyUnits(id: string, units: string[]): void {
  const db = getDb();
  const existing = rowsAs<TaxonomyType>(
    db.executeSync(`SELECT * FROM taxonomy_types WHERE id = ? LIMIT 1`, [id]).rows,
  )[0];
  if (!existing) return;
  let meta: Record<string, unknown> = {};
  try { meta = existing.meta ? (JSON.parse(existing.meta) as Record<string, unknown>) : {}; } catch { meta = {}; }
  meta.units = units;
  const metaStr = JSON.stringify(meta);
  const updated_at = new Date().toISOString();
  db.executeSync(
    `INSERT OR REPLACE INTO taxonomy_types (id, category, label, icon, sort_order, active, updated_at, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    bindParams([existing.id, existing.category, existing.label, existing.icon, existing.sort_order, existing.active, updated_at, metaStr]),
  );
  appendOutbox('INSERT', 'taxonomy_types', {
    id: existing.id, category: existing.category, label: existing.label, icon: existing.icon,
    sort_order: existing.sort_order, active: existing.active === 1, updated_at, meta: metaStr,
  });
}

// Parse a taxonomy_types.meta JSON blob into the units/allowDecimals shape.
// Tolerant: null, empty, or malformed JSON falls back to {units:[], allowDecimals:true}.
function parseClassMeta(meta: string | null | undefined): {
  units: string[];
  allowDecimals: boolean;
} {
  if (!meta) return { units: [], allowDecimals: true };
  try {
    const parsed = JSON.parse(meta) as { units?: unknown; allowDecimals?: unknown };
    const units = Array.isArray(parsed.units)
      ? parsed.units.filter((u): u is string => typeof u === 'string')
      : [];
    const allowDecimals =
      typeof parsed.allowDecimals === 'boolean' ? parsed.allowDecimals : true;
    return { units, allowDecimals };
  } catch {
    return { units: [], allowDecimals: true };
  }
}

function toProductClass(row: TaxonomyType): ProductClass {
  const { units, allowDecimals } = parseClassMeta(row.meta);
  return {
    id: row.id,
    label: row.label,
    icon: row.icon,
    units,
    allowDecimals,
    active: row.active,
    sort_order: row.sort_order,
  };
}

export function getProductClasses(opts?: {
  includeInactive?: boolean;
}): ProductClass[] {
  return getTaxonomyTypes(PRODUCT_CLASS_CATEGORY, opts).map(toProductClass);
}

export function getProductClassById(id: string): ProductClass | null {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM taxonomy_types WHERE id = ? AND category = ? LIMIT 1`,
    [id, PRODUCT_CLASS_CATEGORY],
  );
  const row = rowsAs<TaxonomyType>(result.rows)[0];
  return row ? toProductClass(row) : null;
}

export function setClassMeta(
  id: string,
  { units, allowDecimals }: { units: string[]; allowDecimals: boolean },
): void {
  const db = getDb();
  const updated_at = new Date().toISOString();

  const existingResult = db.executeSync(
    `SELECT * FROM taxonomy_types WHERE id = ? LIMIT 1`,
    [id],
  );
  const existing = rowsAs<TaxonomyType>(existingResult.rows)[0];
  if (!existing) return;

  const meta = JSON.stringify({ units, allowDecimals });

  db.executeSync(
    `INSERT OR REPLACE INTO taxonomy_types (id, category, label, icon, sort_order, active, updated_at, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    bindParams([
      existing.id,
      existing.category,
      existing.label,
      existing.icon,
      existing.sort_order,
      existing.active,
      updated_at,
      meta,
    ]),
  );
  appendOutbox('INSERT', 'taxonomy_types', {
    id: existing.id,
    category: existing.category,
    label: existing.label,
    icon: existing.icon,
    sort_order: existing.sort_order,
    active: existing.active === 1,
    updated_at,
    meta,
  });
}

// Update ONLY the classId inside an item_category row's meta, preserving the
// units array. Lets admins remap which unit class a type uses (e.g. Chemicals →
// liquid) from Manage Types.
export function setTaxonomyClassId(id: string, classId: string): void {
  const db = getDb();
  const existing = rowsAs<TaxonomyType>(
    db.executeSync(`SELECT * FROM taxonomy_types WHERE id = ? LIMIT 1`, [id]).rows,
  )[0];
  if (!existing) return;
  let meta: Record<string, unknown> = {};
  try { meta = existing.meta ? (JSON.parse(existing.meta) as Record<string, unknown>) : {}; } catch { meta = {}; }
  meta.classId = classId;
  const metaStr = JSON.stringify(meta);
  const updated_at = new Date().toISOString();
  db.executeSync(
    `INSERT OR REPLACE INTO taxonomy_types (id, category, label, icon, sort_order, active, updated_at, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    bindParams([existing.id, existing.category, existing.label, existing.icon, existing.sort_order, existing.active, updated_at, metaStr]),
  );
  appendOutbox('INSERT', 'taxonomy_types', {
    id: existing.id, category: existing.category, label: existing.label, icon: existing.icon,
    sort_order: existing.sort_order, active: existing.active === 1, updated_at, meta: metaStr,
  });
}

export function getTaxonomyTypes(
  category: string,
  opts?: { includeInactive?: boolean },
): TaxonomyType[] {
  const db = getDb();
  const includeInactive = opts?.includeInactive ?? false;
  const sql = includeInactive
    ? `SELECT * FROM taxonomy_types WHERE category = ? ORDER BY sort_order ASC, label ASC`
    : `SELECT * FROM taxonomy_types WHERE category = ? AND active = 1 ORDER BY sort_order ASC, label ASC`;
  const result = db.executeSync(sql, [category]);
  return rowsAs<TaxonomyType>(result.rows);
}

export function getTypeIcon(category: string, label: string): string | null {
  const db = getDb();
  const result = db.executeSync(
    `SELECT icon FROM taxonomy_types WHERE category = ? AND label = ? LIMIT 1`,
    [category, label],
  );
  const row = result.rows[0] as { icon: string | null } | undefined;
  return row?.icon ?? null;
}

export function addTaxonomyType({
  category,
  label,
  icon,
  meta,
}: {
  category: string;
  label: string;
  icon: string | null;
  meta?: string | null;
}): void {
  const db = getDb();
  const id = generateUUID();
  const updated_at = new Date().toISOString();
  const metaValue = meta ?? null;

  // Compute max sort_order for this category so new entry appends at the end
  const maxResult = db.executeSync(
    `SELECT MAX(sort_order) AS max_order FROM taxonomy_types WHERE category = ?`,
    [category],
  );
  const maxRow = maxResult.rows[0] as { max_order: number | null } | undefined;
  const sort_order = (maxRow?.max_order ?? 0) + 1;

  db.executeSync(
    `INSERT OR REPLACE INTO taxonomy_types (id, category, label, icon, sort_order, active, updated_at, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    bindParams([id, category, label, icon, sort_order, 1, updated_at, metaValue]),
  );
  appendOutbox('INSERT', 'taxonomy_types', {
    id,
    category,
    label,
    icon,
    sort_order,
    active: true,
    updated_at,
    meta: metaValue,
  });
}

export function renameTaxonomyType(id: string, label: string): void {
  const db = getDb();
  const updated_at = new Date().toISOString();

  const existingResult = db.executeSync(
    `SELECT * FROM taxonomy_types WHERE id = ? LIMIT 1`,
    [id],
  );
  const existing = rowsAs<TaxonomyType>(existingResult.rows)[0];
  if (!existing) return;

  db.executeSync(
    `INSERT OR REPLACE INTO taxonomy_types (id, category, label, icon, sort_order, active, updated_at, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    bindParams([existing.id, existing.category, label, existing.icon, existing.sort_order, existing.active, updated_at, existing.meta ?? null]),
  );
  appendOutbox('INSERT', 'taxonomy_types', {
    id: existing.id,
    category: existing.category,
    label,
    icon: existing.icon,
    sort_order: existing.sort_order,
    active: existing.active === 1,
    updated_at,
    meta: existing.meta ?? null,
  });
}

export function setTaxonomyIcon(id: string, icon: string | null): void {
  const db = getDb();
  const updated_at = new Date().toISOString();

  const existingResult = db.executeSync(
    `SELECT * FROM taxonomy_types WHERE id = ? LIMIT 1`,
    [id],
  );
  const existing = rowsAs<TaxonomyType>(existingResult.rows)[0];
  if (!existing) return;

  db.executeSync(
    `INSERT OR REPLACE INTO taxonomy_types (id, category, label, icon, sort_order, active, updated_at, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    bindParams([existing.id, existing.category, existing.label, icon, existing.sort_order, existing.active, updated_at, existing.meta ?? null]),
  );
  appendOutbox('INSERT', 'taxonomy_types', {
    id: existing.id,
    category: existing.category,
    label: existing.label,
    icon,
    sort_order: existing.sort_order,
    active: existing.active === 1,
    updated_at,
    meta: existing.meta ?? null,
  });
}

export function setTaxonomyActive(id: string, active: boolean): void {
  const db = getDb();
  const updated_at = new Date().toISOString();

  const existingResult = db.executeSync(
    `SELECT * FROM taxonomy_types WHERE id = ? LIMIT 1`,
    [id],
  );
  const existing = rowsAs<TaxonomyType>(existingResult.rows)[0];
  if (!existing) return;

  const activeInt = active ? 1 : 0;
  db.executeSync(
    `INSERT OR REPLACE INTO taxonomy_types (id, category, label, icon, sort_order, active, updated_at, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    bindParams([existing.id, existing.category, existing.label, existing.icon, existing.sort_order, activeInt, updated_at, existing.meta ?? null]),
  );
  appendOutbox('INSERT', 'taxonomy_types', {
    id: existing.id,
    category: existing.category,
    label: existing.label,
    icon: existing.icon,
    sort_order: existing.sort_order,
    active,
    updated_at,
    meta: existing.meta ?? null,
  });
}

export function reorderTaxonomyType(id: string, sort_order: number): void {
  const db = getDb();
  const updated_at = new Date().toISOString();

  const existingResult = db.executeSync(
    `SELECT * FROM taxonomy_types WHERE id = ? LIMIT 1`,
    [id],
  );
  const existing = rowsAs<TaxonomyType>(existingResult.rows)[0];
  if (!existing) return;

  db.executeSync(
    `INSERT OR REPLACE INTO taxonomy_types (id, category, label, icon, sort_order, active, updated_at, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    bindParams([existing.id, existing.category, existing.label, existing.icon, sort_order, existing.active, updated_at, existing.meta ?? null]),
  );
  appendOutbox('INSERT', 'taxonomy_types', {
    id: existing.id,
    category: existing.category,
    label: existing.label,
    icon: existing.icon,
    sort_order,
    active: existing.active === 1,
    updated_at,
    meta: existing.meta ?? null,
  });
}
