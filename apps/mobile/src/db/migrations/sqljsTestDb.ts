import initSqlJs from 'sql.js';
import type { SqlDb } from '../types';

// Node-only in-memory SqlDb for migration unit tests. Same executeSync shape as
// locationsShelf.testdb.ts; each test builds its own pre-migration tables.
export async function makeSqlJsDb(): Promise<SqlDb> {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  return {
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
}
