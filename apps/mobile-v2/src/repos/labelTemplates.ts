// Station D2: read-only port of apps/mobile/src/db/queries/labelTemplates.ts.
// The visual template DESIGNER is dropped in the rebuild (plan decision #3) —
// only PRINTING with templates survives, so the old file's create/update/
// deactivate mutations are deliberately not ported. Existing org-synced
// custom templates keep printing via printLabelsWithModel; `fields` is a JSON
// string in TEXT (taxonomy_types.meta idiom) round-tripped here.
import { getDb, rowsAs } from '../db/schema';
import type { LabelTemplateModel, LabelField } from '../labels/positioned';

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
  return rowsAs<LabelTemplateRow>(
    getDb().executeSync(`SELECT * FROM label_templates WHERE active = 1 ORDER BY updated_at DESC`).rows,
  ).map(rowToModel);
}

export function getLabelTemplate(id: string): LabelTemplateModel | null {
  const r = rowsAs<LabelTemplateRow>(
    getDb().executeSync(`SELECT * FROM label_templates WHERE id = ? AND active = 1`, [id]).rows,
  )[0];
  return r ? rowToModel(r) : null;
}
