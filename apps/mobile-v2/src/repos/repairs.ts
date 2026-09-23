import { createRepository } from '@invenpro/core';
import { getDb, rowsAs } from '../db/schema';
import { generateUUID } from '../utils/uuid';
import { resolveTypeId, resolveLabels, REPAIR_STATUS } from './taxonomy';

// repairs / repair_parts / repair_steps domain — ported from apps/mobile/src/
// db/queries/repairs.ts (260 ln, Station C4). Import mapping applied
// (docs/REBUILD-PORTING.md):
//   '../schema' (getDb, rowsAs, bindParams) → '../db/schema'
//   '../../sync/outbox' (appendOutbox) + hand-rolled db.executeSync pairs →
//     createRepository('repairs' | 'repair_parts' | 'repair_steps') — the old
//     app's raw SQL + manual appendOutbox calls are replaced with
//     repo.insert()/repo.update(). synced_at is OMITTED from every payload
//     passed to insert()/update() (rather than hand-stripped like the old
//     app) — the column is nullable with no default, so SQLite just leaves it
//     NULL, and since insert()/update() mirror the EXACT object passed in,
//     omitting it keeps it out of the outbox payload for free (same trick
//     schedule.ts's createSlot uses for schedule_assignments).
//   '../../utils/uuid' → '../utils/uuid'
//   './taxonomy' (resolveTypeId, resolveLabels, REPAIR_STATUS) → same names,
//     already ported (repos/taxonomy.ts also already has getRepairStatuses/
//     isTerminalStatus from an earlier station).
//
// No FK on repair_id/item_id/step_id (sync-order safety, matching the old
// app) — repair_parts/repair_steps rows can outbox-sync before their parent
// repairs row lands.
//
// Self-log convention: NONE of these functions self-log (matches B/C1-C3's
// caller-owned convention) — callers wrap runInTransaction(() => { repoFn();
// appendLog(...); }).

const repairsRepo = createRepository('repairs');
const repairPartsRepo = createRepository('repair_parts');
const repairStepsRepo = createRepository('repair_steps');

export interface Repair {
  id: string;
  entity_type: 'equipment_unit' | 'item' | 'location';
  entity_id: string;
  entity_label: string | null;
  notes: string | null;
  parts_needed: string | null;
  status: string; // a repair_status label
  // Durable taxonomy FK (migration 031, #74 Phase 3b) — `status` is the label cache.
  status_id?: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  assignee_id?: string | null;
  cost?: number | null;
  due_at?: string | null; // target completion for SLA
  synced_at?: string | null; // local-only
}

// A row of repair_parts: inventory consumed by a repair ticket. step_id
// (migration 057, #178 Part 4) optionally links the part to the
// troubleshooting step it was consumed under — null for parts used before
// any step is logged.
export interface RepairPart {
  id: string;
  repair_id: string;
  item_id: string;
  qty: number;
  unit: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  step_id?: string | null;
  synced_at?: string | null; // local-only
}

// A row of repair_steps (#178 v1): an immutable troubleshooting log entry —
// "what did you try?" (action, required) and its outcome (result, optional).
// Never UPDATEd/DELETEd — the server rejects both (syncPolicy.ts OPERATION_PERM).
export interface RepairStep {
  id: string;
  repair_id: string;
  action: string;
  result: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
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
  // Resolve `status` from status_id so a repair_status rename shows immediately (#74 P3b).
  return resolveLabels(rowsAs<Repair>(result.rows), 'status_id', 'status');
}

export function getRepairsForEntity(entityType: string, entityId: string): Repair[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM repairs WHERE entity_type = ? AND entity_id = ? ORDER BY updated_at DESC`,
    [entityType, entityId],
  );
  return resolveLabels(rowsAs<Repair>(result.rows), 'status_id', 'status');
}

export function getRepairById(id: string): Repair | null {
  const db = getDb();
  const result = db.executeSync(`SELECT * FROM repairs WHERE id = ?`, [id]);
  return resolveLabels(rowsAs<Repair>(result.rows), 'status_id', 'status')[0] ?? null;
}

// Insert a new ticket. Returns the new Repair (caller owns appendLog).
export function createRepair(input: {
  entity_type: Repair['entity_type'];
  entity_id: string;
  entity_label: string | null;
  notes: string | null;
  parts_needed: string | null;
  status: string;
  created_by: string | null;
  assignee_id?: string | null;
  cost?: number | null;
  due_at?: string | null;
}): Repair {
  const now = new Date().toISOString();
  // Durable taxonomy FK (#74 P3b): resolve the status label to its taxonomy id so a
  // later repair_status rename resolves via the id, not the stale label cache.
  const statusId = resolveTypeId(REPAIR_STATUS, input.status);
  const repair: Repair = {
    id: generateUUID(),
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    entity_label: input.entity_label,
    notes: input.notes,
    parts_needed: input.parts_needed,
    status: input.status,
    status_id: statusId,
    created_by: input.created_by,
    created_at: now,
    updated_at: now,
    completed_at: null,
    assignee_id: input.assignee_id ?? null,
    cost: input.cost ?? null,
    due_at: input.due_at ?? null,
  };
  repairsRepo.insert({ ...repair });
  return repair;
}

// Partial edit of notes/parts_needed/entity_label/assignee_id/cost/due_at.
// Returns updated_at. Also used as the assignee/cost/due-date write path
// (setRepairAssignee et al aren't separate functions — this allowlist covers them).
export function updateRepairFields(
  id: string,
  fields: Partial<Pick<Repair, 'notes' | 'parts_needed' | 'entity_label' | 'assignee_id' | 'cost' | 'due_at'>>,
): string {
  const now = new Date().toISOString();
  if (Object.keys(fields).length === 0) return now;
  repairsRepo.update({ id, ...fields, updated_at: now });
  return now;
}

// Set the status; a terminal status stamps completed_at (else clears it).
// Returns the new updated_at + whether it is now completed.
export function updateRepairStatus(
  id: string,
  status: string,
  terminal: boolean,
): { updated_at: string; completed: boolean } {
  const now = new Date().toISOString();
  const completedAt = terminal ? now : null;
  // Keep the durable FK in step with the label (#74 P3b).
  const statusId = resolveTypeId(REPAIR_STATUS, status);
  repairsRepo.update({ id, status, status_id: statusId, completed_at: completedAt, updated_at: now });
  return { updated_at: now, completed: terminal };
}

// Record inventory consumed by a repair ticket. stepId (#178 Part 4)
// optionally links the part to the current/latest troubleshooting step; omit/
// null for parts used before any step is logged. Returns the new
// repair_parts row id.
export function addRepairPart(
  repairId: string,
  itemId: string,
  qty: number,
  unit: string,
  createdBy: string | null = null,
  stepId: string | null = null,
): string {
  const id = generateUUID();
  repairPartsRepo.insert({
    id, repair_id: repairId, item_id: itemId, qty, unit,
    created_by: createdBy, step_id: stepId,
  });
  return id;
}

// Parts consumed by a repair ticket, most recent first.
export function getRepairParts(repairId: string): RepairPart[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM repair_parts WHERE repair_id = ? ORDER BY created_at DESC`,
    [repairId],
  );
  return rowsAs<RepairPart>(result.rows);
}

// Log a troubleshooting step against a repair ticket. Immutable once written
// — there is no updateRepairStep (server rejects UPDATE/DELETE via
// syncPolicy.ts OPERATION_PERM). Returns the new repair_steps row id.
export function addRepairStep(
  repairId: string,
  action: string,
  result: string | null,
  createdBy: string | null = null,
): string {
  const id = generateUUID();
  repairStepsRepo.insert({ id, repair_id: repairId, action, result, created_by: createdBy });
  return id;
}

// Troubleshooting steps for a repair ticket, chronological (oldest first) —
// the log reads top-to-bottom as the sequence of things tried.
export function getRepairSteps(repairId: string): RepairStep[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM repair_steps WHERE repair_id = ? ORDER BY created_at ASC`,
    [repairId],
  );
  return rowsAs<RepairStep>(result.rows);
}
