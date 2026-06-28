import { getDb, rowsAs, bindParams } from '../schema';
import { appendOutbox } from '../../sync/outbox';
import { generateUUID } from '../../utils/uuid';

export interface Repair {
  id: string;
  entity_type: 'equipment_unit' | 'item' | 'location';
  entity_id: string;
  entity_label: string | null;
  notes: string | null;
  parts_needed: string | null;
  status: string; // a repair_status label
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  synced_at?: string | null; // local-only
}

// Open = not yet completed (completed_at IS NULL); Done = completed_at set.
export function getRepairs(opts?: { done?: boolean; entityType?: string }): Repair[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (opts?.done === true) clauses.push('completed_at IS NOT NULL');
  if (opts?.done === false) clauses.push('completed_at IS NULL');
  if (opts?.entityType) { clauses.push('entity_type = ?'); params.push(opts.entityType); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = db.executeSync(
    `SELECT * FROM repairs ${where} ORDER BY (completed_at IS NULL) DESC, updated_at DESC`,
    params,
  );
  return rowsAs<Repair>(result.rows);
}

export function getRepairsForEntity(entityType: string, entityId: string): Repair[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM repairs WHERE entity_type = ? AND entity_id = ? ORDER BY updated_at DESC`,
    [entityType, entityId],
  );
  return rowsAs<Repair>(result.rows);
}

export function getRepairById(id: string): Repair | null {
  const db = getDb();
  const result = db.executeSync(`SELECT * FROM repairs WHERE id = ?`, [id]);
  return (result.rows[0] as unknown as Repair) ?? null;
}

// Insert a new ticket locally + queue the outbox INSERT (synced_at stripped — the
// server table has no such column). Returns the new Repair.
export function createRepair(input: {
  entity_type: Repair['entity_type'];
  entity_id: string;
  entity_label: string | null;
  notes: string | null;
  parts_needed: string | null;
  status: string;
  created_by: string | null;
}): Repair {
  const db = getDb();
  const now = new Date().toISOString();
  const repair: Repair = {
    id: generateUUID(),
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    entity_label: input.entity_label,
    notes: input.notes,
    parts_needed: input.parts_needed,
    status: input.status,
    created_by: input.created_by,
    created_at: now,
    updated_at: now,
    completed_at: null,
    synced_at: null,
  };
  db.executeSync(
    `INSERT INTO repairs (id, entity_type, entity_id, entity_label, notes, parts_needed, status, created_by, created_at, updated_at, completed_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    bindParams([repair.id, repair.entity_type, repair.entity_id, repair.entity_label,
      repair.notes, repair.parts_needed, repair.status, repair.created_by,
      repair.created_at, repair.updated_at, repair.completed_at]),
  );
  appendOutbox('INSERT', 'repairs', {
    id: repair.id, entity_type: repair.entity_type, entity_id: repair.entity_id,
    entity_label: repair.entity_label, notes: repair.notes, parts_needed: repair.parts_needed,
    status: repair.status, created_by: repair.created_by,
    created_at: repair.created_at, updated_at: repair.updated_at, completed_at: null,
  });
  return repair;
}

// Partial edit of notes/parts_needed/entity_label + outbox UPDATE. Returns updated_at.
export function updateRepairFields(
  id: string,
  fields: Partial<Pick<Repair, 'notes' | 'parts_needed' | 'entity_label'>>,
): string {
  const db = getDb();
  const now = new Date().toISOString();
  const entries = Object.entries(fields);
  if (entries.length === 0) return now;
  const setClause = entries.map(([k]) => `${k} = ?`).join(', ');
  db.executeSync(
    `UPDATE repairs SET ${setClause}, updated_at = ? WHERE id = ?`,
    bindParams([...entries.map(([, v]) => v), now, id]),
  );
  appendOutbox('UPDATE', 'repairs', { id, ...fields, updated_at: now });
  return now;
}

// Set the status; a terminal status stamps completed_at (else clears it).
// Returns the new updated_at + whether it is now completed.
export function updateRepairStatus(
  id: string,
  status: string,
  terminal: boolean,
): { updated_at: string; completed: boolean } {
  const db = getDb();
  const now = new Date().toISOString();
  const completedAt = terminal ? now : null;
  db.executeSync(
    `UPDATE repairs SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
    [status, completedAt, now, id],
  );
  appendOutbox('UPDATE', 'repairs', { id, status, completed_at: completedAt, updated_at: now });
  return { updated_at: now, completed: terminal };
}
