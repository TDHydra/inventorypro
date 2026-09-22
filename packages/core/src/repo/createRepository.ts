// The ONE write path for synced tables — local SQLite write + outbox mirror,
// atomically, with the reactive bump handled by tx.ts. Domain repos wrap this
// (apps/*/src/repos/); screens never call appendOutbox directly anymore
// (enforced by eslint no-restricted-imports in the app packages — the old app
// had 21 screens each hand-rolling this pair and any drift between the local
// write and the outbox payload silently forked device state from the server).
import { getDb, bindParams } from '../db/provider';
import { runInTransaction, queueTableBump } from '../db/tx';
import { appendOutbox, type OutboxOperation } from '../sync/outbox';
import { getTableSpec } from '../manifest/derive';
import type { TableSpec } from '../manifest/types';

export interface Repository {
  /** INSERT OR REPLACE the row locally (columns intersected with the manifest)
   *  and mirror it to the outbox as INSERT. Fills updated_at/created_at with
   *  now-ISO when the table has them and the caller didn't. */
  insert(row: Record<string, unknown>): void;
  /** Partial update: `patch` must contain the table's conflict-target key(s).
   *  Touches updated_at unless provided. Local UPDATE of exactly the patch
   *  columns + outbox UPDATE with the same payload — one payload, no drift. */
  update(patch: Record<string, unknown>): void;
  /** Local DELETE + outbox DELETE. Refuses tables the server forbids deleting
   *  (users/role_settings/app_config) — fail here, not 5 retries later. */
  remove(keys: Record<string, unknown>): void;
  /** Escape hatch for bespoke flows (ADJUST stock deltas, multi-row writes):
   *  runs `localWrite` and appends the given outbox payload atomically. */
  mirror(operation: OutboxOperation, payload: Record<string, unknown>, localWrite?: () => void): void;
  readonly spec: TableSpec;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createRepository(tableName: string): Repository {
  const spec = getTableSpec(tableName);
  if (!spec) throw new Error(`createRepository: no manifest spec for table '${tableName}'`);
  if (spec.sync === 'device-only' || spec.sync === 'server-only') {
    throw new Error(`createRepository: '${tableName}' is ${spec.sync} — it has no outbox mirror`);
  }
  const colNames = new Set(spec.columns.map(c => c.name));
  const keys = spec.conflictTarget ?? ['id'];

  function touchTimestamps(row: Record<string, unknown>, includeCreated: boolean): Record<string, unknown> {
    const out = { ...row };
    if (colNames.has('updated_at') && out.updated_at === undefined) out.updated_at = nowIso();
    if (includeCreated && colNames.has('created_at') && out.created_at === undefined) out.created_at = nowIso();
    return out;
  }

  function assertKeys(row: Record<string, unknown>, what: string): void {
    for (const k of keys) {
      if (row[k] === undefined || row[k] === null) {
        throw new Error(`${tableName}.${what}: missing key column '${k}'`);
      }
    }
  }

  return {
    spec,

    insert(row) {
      const payload = touchTimestamps(row, true);
      assertKeys(payload, 'insert');
      const cols = Object.keys(payload).filter(c => colNames.has(c));
      runInTransaction(() => {
        getDb().executeSync(
          `INSERT OR REPLACE INTO ${tableName} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`,
          bindParams(cols.map(c => payload[c])),
        );
        appendOutbox('INSERT', tableName, payload);
      });
    },

    update(patch) {
      const payload = touchTimestamps(patch, false);
      assertKeys(payload, 'update');
      const setCols = Object.keys(payload).filter(c => colNames.has(c) && !keys.includes(c));
      if (setCols.length === 0) throw new Error(`${tableName}.update: nothing to set`);
      runInTransaction(() => {
        getDb().executeSync(
          `UPDATE ${tableName} SET ${setCols.map(c => `${c} = ?`).join(', ')} WHERE ${keys.map(k => `${k} = ?`).join(' AND ')}`,
          bindParams([...setCols.map(c => payload[c]), ...keys.map(k => payload[k])]),
        );
        appendOutbox('UPDATE', tableName, payload);
      });
    },

    remove(rowKeys) {
      if (spec.deleteForbidden) {
        throw new Error(`${tableName}.remove: DELETE is never allowed through sync for this table`);
      }
      assertKeys(rowKeys, 'remove');
      runInTransaction(() => {
        getDb().executeSync(
          `DELETE FROM ${tableName} WHERE ${keys.map(k => `${k} = ?`).join(' AND ')}`,
          bindParams(keys.map(k => rowKeys[k])),
        );
        appendOutbox('DELETE', tableName, Object.fromEntries(keys.map(k => [k, rowKeys[k]])));
      });
    },

    mirror(operation, payload, localWrite) {
      runInTransaction(() => {
        localWrite?.();
        // localWrite may touch this or other tables via raw SQL — the caller
        // is responsible for queueTableBump on any EXTRA tables it writes;
        // appendOutbox bumps `tableName` itself.
        queueTableBump(tableName);
        appendOutbox(operation, tableName, payload);
      });
    },
  };
}
