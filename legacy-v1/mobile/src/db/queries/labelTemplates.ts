import { getDb, rowsAs, bindParams } from '../schema';
import { appendOutbox } from '../../sync/outbox';
import { generateUUID } from '../../utils/uuid';
import { isWriteBlocked } from '../maintenance';
import type { LabelTemplateModel, LabelField } from '../../labels/positioned';

// Org-synced custom label templates (visual designer). `fields` is stored as a
// JSON string in TEXT (taxonomy_types.meta idiom) and round-tripped here. Writes
// are admin-gated server-side (syncPolicy OPERATION_PERM label_templates =
// system_settings); reads are open to every device.

interface LabelTemplateRow {
  id: string;
  name: string;
  width_in: number;
  height_in: number;
  dpi: number;
  fields: string;
  active: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function parseFields(json: string): LabelField[] {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? (arr as LabelField[]) : [];
  } catch {
    return [];
  }
}

function rowToModel(r: LabelTemplateRow): LabelTemplateModel {
  return {
    id: r.id,
    name: r.name,
    widthIn: r.width_in,
    heightIn: r.height_in,
    dpi: r.dpi,
    fields: parseFields(r.fields),
  };
}

/** All active templates, newest first. */
export function getLabelTemplates(): LabelTemplateModel[] {
  const db = getDb();
  const rows = rowsAs<LabelTemplateRow>(
    db.executeSync(`SELECT * FROM label_templates WHERE active = 1 ORDER BY updated_at DESC`).rows,
  );
  return rows.map(rowToModel);
}

export function getLabelTemplate(id: string): LabelTemplateModel | null {
  const db = getDb();
  const r = rowsAs<LabelTemplateRow>(
    db.executeSync(`SELECT * FROM label_templates WHERE id = ? AND active = 1`, [id]).rows,
  )[0];
  return r ? rowToModel(r) : null;
}

/**
 * Create or update a template (INSERT OR REPLACE + idempotent-upsert outbox, the
 * taxonomy pattern). Pass a model with an existing id to edit, or a fresh id to
 * create. Returns the id used. No-op when writes are blocked (maintenance mode).
 */
export function upsertLabelTemplate(model: Omit<LabelTemplateModel, 'id'> & { id?: string }, userId: string | null): string {
  if (isWriteBlocked()) return model.id ?? '';
  const db = getDb();
  const id = model.id ?? generateUUID();
  const updated_at = new Date().toISOString();

  // Preserve created_at/created_by on edit; stamp them on create.
  const existing = db.executeSync(`SELECT created_at, created_by FROM label_templates WHERE id = ?`, [id])
    .rows[0] as { created_at: string; created_by: string | null } | undefined;
  const created_at = existing?.created_at ?? updated_at;
  const created_by = existing?.created_by ?? userId;
  const fieldsJson = JSON.stringify(model.fields ?? []);

  db.executeSync(
    `INSERT OR REPLACE INTO label_templates
       (id, name, width_in, height_in, dpi, fields, active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindParams([id, model.name, model.widthIn, model.heightIn, model.dpi, fieldsJson, 1, created_by, created_at, updated_at]),
  );
  appendOutbox('INSERT', 'label_templates', {
    id, name: model.name, width_in: model.widthIn, height_in: model.heightIn, dpi: model.dpi,
    fields: fieldsJson, active: true, created_by, created_at, updated_at,
  });
  return id;
}

/** Soft-delete (active = 0) + sync, mirroring taxonomy's soft delete. */
export function deleteLabelTemplate(id: string): void {
  if (isWriteBlocked()) return;
  const db = getDb();
  const r = rowsAs<LabelTemplateRow>(db.executeSync(`SELECT * FROM label_templates WHERE id = ?`, [id]).rows)[0];
  if (!r) return;
  const updated_at = new Date().toISOString();
  db.executeSync(`UPDATE label_templates SET active = 0, updated_at = ? WHERE id = ?`, [updated_at, id]);
  appendOutbox('INSERT', 'label_templates', {
    id: r.id, name: r.name, width_in: r.width_in, height_in: r.height_in, dpi: r.dpi,
    fields: r.fields, active: false, created_by: r.created_by, created_at: r.created_at, updated_at,
  });
}
