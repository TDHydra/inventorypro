// Runs the full baseline DDL on a real sql.js database and checks the result
// against each TableSpec's column truth (name/type/notnull/default captured
// from the old app's live migration chain). Guards both directions: a manifest
// edit that breaks the DDL fails here, and a columns[] edit that no longer
// matches the verbatim DDL fails here.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { BASELINE_TABLES } from '../manifest/derive';
import { baselineDdl } from './baseline';

interface ColInfo { name: string; type: string; notnull: number; dflt_value: unknown; }

let tableInfo: (t: string) => ColInfo[];

before(async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  for (const ddl of baselineDdl()) db.exec(ddl);
  tableInfo = (t: string) => {
    const res = db.exec(`PRAGMA table_info(${t})`);
    return res[0].values.map(v => {
      const obj: Record<string, unknown> = {};
      res[0].columns.forEach((c, i) => { obj[c] = v[i]; });
      return obj as unknown as ColInfo;
    });
  };
});

test('baseline creates every on-device table', () => {
  for (const spec of BASELINE_TABLES) {
    assert.ok(tableInfo(spec.name).length > 0, `table ${spec.name} missing`);
  }
});

for (const specName of ['users', 'inventory_items', 'outbox', 'on_call_shifts', 'app_settings']) {
  test(`baseline column truth spot-check: ${specName}`, () => {
    const spec = BASELINE_TABLES.find(s => s.name === specName)!;
    const cols = tableInfo(specName);
    assert.deepEqual(cols.map(c => c.name), spec.columns.map(c => c.name), 'column names + order');
    for (let i = 0; i < cols.length; i++) {
      const expected = spec.columns[i];
      assert.equal(cols[i].type, expected.type ?? 'TEXT', `${specName}.${cols[i].name} type`);
      assert.equal(!!cols[i].notnull, !!expected.notNull, `${specName}.${cols[i].name} notnull`);
    }
  });
}

test('every table: columns[] matches the DDL exactly (full sweep)', () => {
  for (const spec of BASELINE_TABLES) {
    const cols = tableInfo(spec.name);
    assert.deepEqual(
      cols.map(c => ({ name: c.name, type: c.type || 'TEXT', notNull: !!c.notnull })),
      spec.columns.map(c => ({ name: c.name, type: c.type, notNull: !!c.notNull })),
      `column truth for ${spec.name}`,
    );
  }
});
