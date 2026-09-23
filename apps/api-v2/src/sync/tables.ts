// Manifest-derived table sets — the Phase 7 point of the rewrite: the four
// hand-synced lists the old sync.ts carried (ALLOWED_TABLES, FULL_TABLES,
// CONFLICT_TARGETS, the forbidden/no-upsert/privileged sets) now derive from
// packages/core's table manifest, the same source the mobile client derives
// its pull/upsert contract from. A table added to the manifest is served here
// with no server edit; a table absent from the manifest (locker_access,
// dashboard_presets — dropped in the rebuild) is not served at all.
import {
  PUSH_TABLES,
  FULL_DOWNLOAD_TABLES,
  CONFLICT_TARGETS,
  DELETE_FORBIDDEN_TABLES,
  INSERT_NO_UPSERT_TABLES,
  PRIVILEGED_TABLE_PERM,
} from '@invenpro/core/src/manifest/derive';
import { TABLES } from '@invenpro/core/src/manifest/tables';

export { DELETE_FORBIDDEN_TABLES, INSERT_NO_UPSERT_TABLES, PRIVILEGED_TABLE_PERM };

/** Every table a device may write up through /sync/push. */
export const ALLOWED_TABLES: Set<string> = new Set(PUSH_TABLES);

/** Tables served by /sync/full and iterated by /sync/pull, in full-download
 *  order (role_settings/users first so permissions resolve client-side). */
export const FULL_TABLES: string[] = FULL_DOWNLOAD_TABLES;

export function conflictTarget(table: string): string {
  return CONFLICT_TARGETS[table] ?? 'id';
}

export function keyColumns(table: string): string[] {
  return conflictTarget(table).split(',').map(s => s.trim());
}

// Pull scoping strategy per table comes from the manifest (TableSpec.scope);
// the SQL itself stays server code (lib/scoping.ts + chatScopeSql below).
// 'own-user' tables are matched on user_id = caller (both such tables key on
// user_id; assert at module load so a future own-user table with a different
// column can't silently scope on the wrong one).
const OWN_USER_TABLES = TABLES.filter(t => t.scope === 'own-user').map(t => t.name);
export const SCOPED_TABLES: Record<string, string> =
  Object.fromEntries(OWN_USER_TABLES.map(t => [t, 'user_id']));

const CHAT_SCOPED = new Set(TABLES.filter(t => t.scope === 'chat').map(t => t.name));
export const MEDIA_SCOPED = new Set(TABLES.filter(t => t.scope === 'media').map(t => t.name));

// Chat tables have a scoped pull the single-column SCOPED_TABLES map can't
// express: a device may only pull conversations/participants/messages for
// conversations it participates in. Returns the extra WHERE fragment
// (parameterized on the caller id via `callerParam`, e.g. '$2').
export function chatScopeSql(table: string, callerParam: string): string | null {
  if (!CHAT_SCOPED.has(table)) return null;
  const mine = `SELECT conversation_id FROM conversation_participants WHERE user_id = ${callerParam}`;
  return table === 'conversations' ? `id IN (${mine})` : `conversation_id IN (${mine})`;
}

/** Manifest-vs-PG drift assertion, run at boot against loadTableColumns'
 *  introspection. Returns human-readable drift lines (empty = clean):
 *   - a manifest-served table missing from PG entirely
 *   - a conflict-target column PG doesn't have (the generic upsert would 500)
 *   - a pull-contract column PG doesn't have (the projection would 500)
 *  The caller decides whether to throw (production index.ts does) or log
 *  (tests register routes with partial column stubs). */
export function manifestPgDrift(realColumns: Map<string, Set<string>>): string[] {
  const drift: string[] = [];
  const served = new Set([...ALLOWED_TABLES, ...FULL_TABLES]);
  for (const spec of TABLES) {
    if (!served.has(spec.name)) continue;
    const cols = realColumns.get(spec.name);
    if (!cols || cols.size === 0) {
      drift.push(`table ${spec.name}: missing from Postgres`);
      continue;
    }
    for (const k of spec.conflictTarget ?? []) {
      if (!cols.has(k)) drift.push(`table ${spec.name}: conflict-target column ${k} missing from Postgres`);
    }
    for (const c of spec.pullColumns ?? []) {
      if (!cols.has(c.name)) drift.push(`table ${spec.name}: pull column ${c.name} missing from Postgres`);
    }
  }
  return drift;
}
