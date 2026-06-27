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
};

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
}: {
  category: string;
  label: string;
  icon: string | null;
}): void {
  const db = getDb();
  const id = generateUUID();
  const updated_at = new Date().toISOString();

  // Compute max sort_order for this category so new entry appends at the end
  const maxResult = db.executeSync(
    `SELECT MAX(sort_order) AS max_order FROM taxonomy_types WHERE category = ?`,
    [category],
  );
  const maxRow = maxResult.rows[0] as { max_order: number | null } | undefined;
  const sort_order = (maxRow?.max_order ?? 0) + 1;

  db.executeSync(
    `INSERT OR REPLACE INTO taxonomy_types (id, category, label, icon, sort_order, active, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    bindParams([id, category, label, icon, sort_order, 1, updated_at]),
  );
  appendOutbox('INSERT', 'taxonomy_types', {
    id,
    category,
    label,
    icon,
    sort_order,
    active: true,
    updated_at,
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
    `INSERT OR REPLACE INTO taxonomy_types (id, category, label, icon, sort_order, active, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    bindParams([existing.id, existing.category, label, existing.icon, existing.sort_order, existing.active, updated_at]),
  );
  appendOutbox('INSERT', 'taxonomy_types', {
    id: existing.id,
    category: existing.category,
    label,
    icon: existing.icon,
    sort_order: existing.sort_order,
    active: existing.active === 1,
    updated_at,
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
    `INSERT OR REPLACE INTO taxonomy_types (id, category, label, icon, sort_order, active, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    bindParams([existing.id, existing.category, existing.label, icon, existing.sort_order, existing.active, updated_at]),
  );
  appendOutbox('INSERT', 'taxonomy_types', {
    id: existing.id,
    category: existing.category,
    label: existing.label,
    icon,
    sort_order: existing.sort_order,
    active: existing.active === 1,
    updated_at,
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
    `INSERT OR REPLACE INTO taxonomy_types (id, category, label, icon, sort_order, active, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    bindParams([existing.id, existing.category, existing.label, existing.icon, existing.sort_order, activeInt, updated_at]),
  );
  appendOutbox('INSERT', 'taxonomy_types', {
    id: existing.id,
    category: existing.category,
    label: existing.label,
    icon: existing.icon,
    sort_order: existing.sort_order,
    active,
    updated_at,
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
    `INSERT OR REPLACE INTO taxonomy_types (id, category, label, icon, sort_order, active, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    bindParams([existing.id, existing.category, existing.label, existing.icon, sort_order, existing.active, updated_at]),
  );
  appendOutbox('INSERT', 'taxonomy_types', {
    id: existing.id,
    category: existing.category,
    label: existing.label,
    icon: existing.icon,
    sort_order,
    active: existing.active === 1,
    updated_at,
  });
}
