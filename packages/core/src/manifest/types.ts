// The table manifest is the single source of truth for the sync contract.
// Everything that used to live in four hand-synced lists derives from it:
//   - mobile pull upsert SQL + value coercion  (was pull.ts TABLE_UPSERT_SQL/rowToValues)
//   - mobile full-download table order          (was fullDownload.ts SYNC_TABLES)
//   - server push allowlist + conflict targets  (was sync.ts ALLOWED_TABLES/CONFLICT_TARGETS)
//   - the generated SQLite baseline DDL         (was migrations 001–067)

/** SQLite storage class for the generated baseline DDL. PG enum columns are
 *  declared TEXT here — this is the single place the enum→TEXT trap is encoded. */
export interface ColumnSpec {
  name: string;
  type: 'TEXT' | 'INTEGER' | 'REAL';
  notNull?: boolean;
  /** Raw SQLite DDL default expression, e.g. "0" or "'{}'". */
  ddlDefault?: string;
}

/** One pulled column. ORDER inside TableSpec.pullColumns is the wire contract. */
export interface PullColumnSpec {
  name: string;
  /** bool → `v ? 1 : 0`; json → `JSON.stringify(v ?? def)`; plain (default) → `v ?? def ?? null`. */
  coerce?: 'bool' | 'json';
  /** Column has no null-fallback in the contract (server always sends it). */
  required?: boolean;
  /** Fallback value when the server omits/nulls the field. */
  def?: unknown;
  /** Fall back to another column of the same row (media.updated_at ?? created_at). */
  fallbackCol?: string;
}

export type SyncMode =
  | 'both'        // pulled + pushed (normal synced table)
  | 'push-only'   // device writes up, never pulled (activity_log)
  | 'device-only' // local table, never crosses the wire (outbox, telemetry_buffer, app_settings)
  | 'server-only';// exists in PG only, listed for documentation (not emitted in baseline)

/** Pull scoping strategy id — the implementation stays server code. */
export type ScopeId = 'own-user' | 'chat' | 'team' | 'media';

export interface TableSpec {
  name: string;
  sync: SyncMode;
  /** Upsert conflict target (server ON CONFLICT + client PK). */
  conflictTarget?: string[];
  /** Included in first-launch full download. */
  fullDownload?: boolean;
  /** Position in the full download (role_settings/users first so perms resolve). */
  fullDownloadOrder?: number;
  scope?: ScopeId;
  /** Permission required to push writes to this table (resolved server-side from DB). */
  privilegedPerm?: string;
  /** DELETE is never allowed through sync (users are deactivated, not deleted). */
  deleteForbidden?: boolean;
  /** INSERT must be ON CONFLICT DO NOTHING, never upsert (see old sync.ts rationale). */
  insertNoUpsert?: boolean;
  /** No UPDATE/DELETE ever (activity_log audit trail). */
  immutable?: boolean;
  /** Server-controlled columns stripped from push payloads at send time.
   *  Mirrors the UNCONDITIONAL entries of the server's SENSITIVE_DENY map
   *  (apps/api/src/lib/syncPolicy.ts) — the server rejects the WHOLE entry
   *  ("Forbidden columns: ...") if one of these is present, so a payload that
   *  carries one strands in the outbox. Only list columns denied for every
   *  caller; permission-conditional denials (e.g. users.role) must NOT be
   *  stripped here or admin edits would silently vanish. */
  pushStripColumns?: string[];
  /** Full local DDL truth — every column with SQLite type/notnull/default. */
  columns: ColumnSpec[];
  /** Verbatim CREATE TABLE from the real 001–067 migration chain — PKs, UNIQUEs,
   *  FKs, CHECKs exactly as production devices have them. Feeds the generated
   *  baseline; columns[] above is for introspection/typing only. */
  ddl: string;
  /** Verbatim CREATE INDEX statements for this table. */
  indexes?: string[];
  /** The pull contract: exact column order + per-column coercion. Absent for
   *  push-only and device-only tables. */
  pullColumns?: PullColumnSpec[];
}
