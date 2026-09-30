// Platform-neutral shape of the database handle. Native = op-sqlite DB,
// web = the sql.js shim (schema.web.ts). Both expose this synchronous surface,
// so migrations and queries depend on THIS type (never op-sqlite directly) to
// keep op-sqlite out of the web bundle.
export interface SqlDb {
  executeSync(sql: string, params?: unknown[]): { rows: any[] };
  close(): void;
}
