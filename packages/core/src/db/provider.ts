// Platform-neutral database handle + provider seam. Native injects the
// op-sqlite DB, web injects the sql.js shim — core itself never imports
// either driver, which is what lets every module here run under plain
// node:test with an in-memory stand-in.

export interface SqlDb {
  executeSync(sql: string, params?: unknown[]): { rows: any[] };
  close(): void;
}

let provider: (() => SqlDb) | null = null;

/** Called once by the app's schema module (native and web alike). The provider
 *  is a getter, not an instance — the DB can be re-opened (logout wipe). */
export function setDbProvider(next: () => SqlDb): void {
  provider = next;
}

export function getDb(): SqlDb {
  if (!provider) throw new Error('@invenpro/core DB provider not set — call setDbProvider() from the schema module');
  return provider();
}

/** Sanitize one JS value for a SQLite bind slot: booleans → 0/1, plain
 *  objects/arrays (JSONB payloads) → JSON text, undefined → NULL. */
export function toBindable(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v as string | number;
}

export function bindParams(values: unknown[]): (string | number | null)[] {
  return values.map(toBindable);
}
