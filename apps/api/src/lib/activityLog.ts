// The audit trail must record what every authenticated user did — always (#56).
//
// activity_log carries five uuid columns, four of them FKs (team_id, job_id,
// from_location_id, to_location_id → their parent tables; entity_id is a bare
// uuid with no FK). Any of them can reference a row the SERVER does not have:
//
//  - the user lacked the permission for the underlying write, so the entity's
//    INSERT was permanently rejected on push and the mobile engine DROPPED it —
//    but the audit row it produced still points at that id (the prod case: a
//    mitigation_technician creating a job without `create_jobs`);
//  - the entity is simply not synced yet, or was deleted server-side;
//  - a caller logged a non-uuid KEY (a role name, a taxonomy label) into
//    entity_id, which a uuid column rejects outright (22P02).
//
// Postgres answered each of those with an error, applyEntry threw, and the push
// handler returned the generic 'write rejected' — which the mobile engine reads
// as TRANSIENT, so it retried to MAX_OUTBOX_ATTEMPTS and dead-lettered the row.
// The action was never recorded and the outbox sat stuck on it.
//
// So: a bad reference DEGRADES the row, it never destroys it. The offending
// column is nulled (every one of them is nullable, ON DELETE SET NULL) and the
// original id is preserved under metadata.orphaned_refs, so nothing is lost and
// the audit trail stays complete. Authorization is NOT an audit concern: logging
// must never require a permission beyond being authenticated.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

// FK columns → the table each references. Fixed allowlist (never client input),
// so the table names below are safe to interpolate into the probe SQL.
// user_id is deliberately absent: it is always the authenticated caller.
export const ACTIVITY_FK_COLUMNS: Record<string, string> = {
  team_id: 'teams',
  job_id: 'jobs',
  from_location_id: 'locations',
  to_location_id: 'locations',
};

// uuid columns with no FK — malformed input still aborts the INSERT (22P02).
export const ACTIVITY_UUID_COLUMNS = ['entity_id'] as const;

type Pg = { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> };
type Row = Record<string, unknown>;

export interface ResolvedRefs {
  /** Column → the value to write (null where the reference could not be honored). */
  values: Record<string, string | null>;
  /** Column → the original id we had to drop. Empty when everything resolved. */
  orphaned: Record<string, string>;
}

/**
 * Resolve activity_log's uuid/FK columns against what the server actually has.
 * One round-trip: a single EXISTS probe per FK column that needs checking.
 */
export async function resolveActivityRefs(pg: Pg, payload: Row): Promise<ResolvedRefs> {
  const values: Record<string, string | null> = {};
  const orphaned: Record<string, string> = {};
  const probe: Array<{ col: string; table: string; id: string }> = [];

  for (const col of [...Object.keys(ACTIVITY_FK_COLUMNS), ...ACTIVITY_UUID_COLUMNS]) {
    const raw = payload[col];
    if (raw == null || raw === '') {
      values[col] = null;
      continue;
    }
    if (!isUuid(raw)) {
      // A non-uuid (a role key, a taxonomy label) would abort the INSERT.
      values[col] = null;
      orphaned[col] = String(raw);
      continue;
    }
    values[col] = raw;
    const table = ACTIVITY_FK_COLUMNS[col];
    if (table) probe.push({ col, table, id: raw });
  }

  if (probe.length > 0) {
    const selects = probe.map((p, i) => `EXISTS(SELECT 1 FROM ${p.table} WHERE id = $${i + 1}) AS "${p.col}"`);
    const { rows } = await pg.query(`SELECT ${selects.join(', ')}`, probe.map(p => p.id));
    const exists = (rows[0] ?? {}) as Record<string, boolean>;
    for (const p of probe) {
      if (!exists[p.col]) {
        orphaned[p.col] = p.id; // the referenced row is not on the server
        values[p.col] = null;
      }
    }
  }

  return { values, orphaned };
}

/**
 * The client sends metadata as a JSON *string*. Parse it to an object so the
 * jsonb column holds a real object (server-written rows already do) rather than
 * a quoted string, and graft on any references we had to drop.
 * Returns a JSON string ready to bind to the jsonb param, or null.
 */
export function buildActivityMetadata(raw: unknown, orphaned: Record<string, string>): string | null {
  const base = parseMetadata(raw);
  const hasOrphans = Object.keys(orphaned).length > 0;
  if (base === null && !hasOrphans) return null;
  const merged: Row = { ...(base ?? {}) };
  if (hasOrphans) merged.orphaned_refs = orphaned;
  return JSON.stringify(merged);
}

// Never throws: malformed metadata is preserved verbatim rather than dropped.
function parseMetadata(raw: unknown): Row | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Row;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Row;
      return { value: parsed };
    } catch {
      return { value: raw };
    }
  }
  return { value: raw };
}
