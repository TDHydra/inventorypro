import type { TableSpec, PullColumnSpec } from './types';
import { TABLES } from './tables';

const byName = new Map(TABLES.map(t => [t.name, t]));

export function getTableSpec(name: string): TableSpec | undefined {
  return byName.get(name);
}

/** Tables that participate in incremental pull (have a pull contract). */
export const PULL_TABLES: TableSpec[] = TABLES.filter(t => t.sync === 'both' && t.pullColumns);

/** First-launch full-download order (role_settings/users first so perms resolve). */
export const FULL_DOWNLOAD_TABLES: string[] = TABLES
  .filter(t => t.fullDownload)
  .sort((a, b) => (a.fullDownloadOrder ?? 0) - (b.fullDownloadOrder ?? 0))
  .map(t => t.name);

/** Server push allowlist: every table a device may write up. */
export const PUSH_TABLES: string[] = TABLES
  .filter(t => t.sync === 'both' || t.sync === 'push-only')
  .map(t => t.name);

export const DELETE_FORBIDDEN_TABLES: Set<string> = new Set(
  TABLES.filter(t => t.deleteForbidden).map(t => t.name));

export const INSERT_NO_UPSERT_TABLES: Set<string> = new Set(
  TABLES.filter(t => t.insertNoUpsert).map(t => t.name));

export const PRIVILEGED_TABLE_PERM: Record<string, string> = Object.fromEntries(
  TABLES.filter(t => t.privilegedPerm).map(t => [t.name, t.privilegedPerm as string]));

/** Server-side ON CONFLICT target per table (comma-joined column list). */
export const CONFLICT_TARGETS: Record<string, string> = Object.fromEntries(
  TABLES.filter(t => t.conflictTarget && t.sync !== 'device-only')
    .map(t => [t.name, (t.conflictTarget as string[]).join(', ')]));

/** `INSERT OR REPLACE INTO t (a, b) VALUES (?,?)` — replaces pull.ts TABLE_UPSERT_SQL. */
export function upsertSql(spec: TableSpec): string {
  const cols = (spec.pullColumns ?? []).map(c => c.name);
  return `INSERT OR REPLACE INTO ${spec.name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`;
}

/** Ordered bind values for one pulled row — replaces pull.ts rowToValues. */
export function rowToValues(spec: TableSpec, row: Record<string, unknown>): unknown[] {
  return (spec.pullColumns ?? []).map(c => coerceValue(c, row));
}

function coerceValue(c: PullColumnSpec, row: Record<string, unknown>): unknown {
  let v = row[c.name];
  if (c.fallbackCol && (v === null || v === undefined)) v = row[c.fallbackCol];
  switch (c.coerce) {
    case 'bool':
      return v ? 1 : 0;
    case 'json':
      return JSON.stringify(v ?? c.def ?? null);
    default:
      if (c.required) return v;
      return v ?? c.def ?? null;
  }
}

/** All DDL statements (table + indexes) for the generated baseline migration.
 *  Verbatim from the real migration chain — never reconstructed from specs. */
export function tableDdl(spec: TableSpec): string[] {
  return [spec.ddl, ...(spec.indexes ?? [])];
}

/** Every table the baseline creates on-device (synced + push-only + device-local). */
export const BASELINE_TABLES: TableSpec[] = TABLES.filter(t => t.sync !== 'server-only');
