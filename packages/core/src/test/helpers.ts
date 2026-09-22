// node:test helpers: a REAL in-memory SQLite (sql.js) behind the provider
// seam, with tables created from the manifest's verbatim DDL — so the tests
// exercise both the ported sync modules and the manifest's DDL truth.
import initSqlJs from 'sql.js';
import { setDbProvider, type SqlDb } from '../db/provider';
import { configureCore, type CoreConfig } from '../config';
import { getTableSpec, tableDdl } from '../manifest/derive';

export async function initTestDb(tables: string[]): Promise<SqlDb> {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  const db: SqlDb = {
    executeSync(sql: string, params?: unknown[]) {
      const rows: Record<string, unknown>[] = [];
      if (params && params.length > 0) {
        const stmt = raw.prepare(sql);
        stmt.bind(params as never[]);
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
      } else {
        for (const r of raw.exec(sql)) {
          for (const v of r.values) {
            const obj: Record<string, unknown> = {};
            r.columns.forEach((c, i) => { obj[c] = v[i]; });
            rows.push(obj);
          }
        }
      }
      return { rows };
    },
    close() { raw.close(); },
  };

  for (const t of tables) {
    const spec = getTableSpec(t);
    if (!spec) throw new Error(`no manifest spec for test table ${t}`);
    for (const ddl of tableDdl(spec)) db.executeSync(ddl);
  }

  setDbProvider(() => db);
  return db;
}

let uuidCounter = 0;

/** Deterministic core config for tests; override any piece per-test. */
export function configureTestCore(overrides: Partial<CoreConfig> = {}): void {
  uuidCounter = 0;
  configureCore({
    apiBase: 'http://test.local',
    generateUUID: () => `uuid-${String(++uuidCounter).padStart(4, '0')}`,
    auth: {
      getValidJwt: async () => 'test-jwt',
      revalidateSession: async () => undefined,
      getSavedUserId: async () => 'user-1',
    },
    ...overrides,
  });
}

/** Install a scripted global.fetch; returns the recorded calls. */
export function stubFetch(
  handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown; headers?: Record<string, string> },
): Array<{ url: string; init?: RequestInit }> {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url, init);
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => (r.headers ?? {})[k.toLowerCase()] ?? null },
      json: async () => r.body,
      text: async () => JSON.stringify(r.body ?? ''),
    } as unknown as Response;
  };
  return calls;
}
