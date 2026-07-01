import { FastifyPluginAsync } from 'fastify';
import { userHasPermission } from '../lib/permissions';
import {
  loadTableColumns,
  applyWritePolicy,
  requiredOperationPerm,
  isAllowedActivity,
  selectColumnsFor,
  requiresRolesPermForTarget,
} from '../lib/syncPolicy';

interface OutboxEntry {
  id: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE' | 'ADJUST';
  table_name: string;
  payload: Record<string, unknown>;
  created_at: string;
}

interface PushBody {
  entries: OutboxEntry[];
}

const ALLOWED_TABLES = new Set([
  'users', 'locations', 'inventory_items', 'stock_by_location',
  'jobs', 'teams', 'team_members', 'media', 'activity_log', 'role_settings',
  'equipment_units', 'app_config', 'taxonomy_types', 'repairs', 'repair_parts',
]);

// Rows that must never be DELETED through the generic sync path: users are
// deactivated (active=false) not deleted, and roles/config persist. Blocks a
// manage_users holder from destroying a full_admin row via a crafted DELETE.
const DELETE_FORBIDDEN_TABLES = new Set(['users', 'role_settings', 'app_config']);

// Tables whose writes confer privilege — a crew JWT must NOT be able to escalate
// roles, rewrite the permission matrix, flip maintenance mode, or restructure
// teams via a hand-crafted outbox entry. Each maps to the permission the caller
// must actually hold (resolved server-side from the DB, never trusted from the
// JWT role claim). Operational tables (stock, inventory, equipment, jobs, media,
// activity_log, locations, taxonomy) stay open — that's the normal sync surface.
const PRIVILEGED_TABLE_PERM: Record<string, string> = {
  users:         'manage_users',
  role_settings: 'manage_roles_permissions',
  app_config:    'system_settings',
  teams:         'manage_teams',
  team_members:  'manage_teams',
};

// Upsert conflict target per table. Most are keyed by `id`, but a few use a
// composite primary key — using `id` for those throws "column id does not exist"
// and silently drops the write (this broke checkout/checkin stock sync).
const CONFLICT_TARGETS: Record<string, string> = {
  stock_by_location: 'item_id, location_id',
  team_members: 'team_id, user_id',
  role_settings: 'role',
  app_config: 'key',
  taxonomy_types: 'id',
};

function conflictTarget(table: string): string {
  return CONFLICT_TARGETS[table] ?? 'id';
}

function keyColumns(table: string): string[] {
  return conflictTarget(table).split(',').map(s => s.trim());
}

const FULL_TABLES = [
  'role_settings', 'users', 'locations', 'inventory_items',
  'stock_by_location', 'jobs', 'teams', 'team_members', 'media',
  'equipment_units', 'app_config', 'taxonomy_types', 'repairs', 'repair_parts',
];

async function applyEntry(
  pg: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
  entry: OutboxEntry,
  callerUserId: string,
  realColumns: Map<string, Set<string>>,
  can: (perm: string) => boolean,
): Promise<void> {
  const { operation, table_name, payload } = entry;

  // activity_log is append-only (enforced by Postgres RULES). ON CONFLICT is
  // incompatible with rules, so insert idempotently via WHERE NOT EXISTS.
  if (table_name === 'activity_log') {
    if (operation !== 'INSERT') return;
    if (!isAllowedActivity(payload.action, payload.entity_type)) {
      throw new Error('Invalid activity_log action/entity_type');
    }
    // Attribute to the AUTHENTICATED caller, not the client-supplied user_id —
    // otherwise any token could forge audit entries blaming another user.
    // (created_at stays client-supplied: offline events carry their real time.)
    await pg.query(
      `INSERT INTO activity_log
         (id, user_id, team_id, action, entity_type, entity_id,
          from_location_id, to_location_id, quantity, unit,
          job_id, note, metadata, device_id, created_at, synced_at,
          latitude, longitude, location_accuracy)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW(),$16,$17,$18
       WHERE NOT EXISTS (SELECT 1 FROM activity_log WHERE id = $1)`,
      [
        payload.id, callerUserId, payload.team_id ?? null,
        payload.action, payload.entity_type, payload.entity_id ?? null,
        payload.from_location_id ?? null, payload.to_location_id ?? null,
        payload.quantity ?? null, payload.unit ?? null,
        payload.job_id ?? null, payload.note ?? null,
        payload.metadata ? JSON.stringify(payload.metadata) : null,
        payload.device_id ?? null, payload.created_at,
        payload.latitude ?? null, payload.longitude ?? null, payload.location_accuracy ?? null,
      ]
    );
    return;
  }

  // Delta-based stock merge. Movement writers push a SIGNED delta; the server is
  // authoritative. Idempotent via processed_outbox (keyed on the outbox entry id):
  // a retried push finds the dedup row already present → dedup CTE is empty → the
  // INSERT/UPDATE produces no row, so the delta is applied exactly once. Clamped
  // with GREATEST(0, …) so it can never violate the quantity >= 0 CHECK. NOW() is
  // authoritative (never moves updated_at backwards, so other devices' incremental
  // pull `WHERE updated_at > since` always sees the change).
  if (operation === 'ADJUST' && table_name === 'stock_by_location') {
    const itemId = payload.item_id;
    const locationId = payload.location_id;
    const delta = payload.delta;
    if (itemId == null || locationId == null || delta == null) {
      throw new Error('ADJUST stock_by_location requires item_id, location_id, delta');
    }
    await pg.query(
      `WITH dedup AS (
         INSERT INTO processed_outbox (entry_id) VALUES ($1)
         ON CONFLICT (entry_id) DO NOTHING RETURNING entry_id)
       INSERT INTO stock_by_location (item_id, location_id, quantity, updated_at)
       SELECT $2, $3, GREATEST(0, $4), NOW() FROM dedup
       ON CONFLICT (item_id, location_id) DO UPDATE
         SET quantity = GREATEST(0, stock_by_location.quantity + $4),
             updated_at = NOW()`,
      [entry.id, itemId, locationId, delta]
    );
    return;
  }

  // ADJUST is only defined for stock_by_location; reject it for any other table
  // rather than letting it fall through to the generic full-row upsert.
  if (operation === 'ADJUST') {
    throw new Error(`ADJUST not supported for table ${table_name}`);
  }

  const keys = keyColumns(table_name);

  if (operation === 'DELETE') {
    const where = keys.map((k, i) => `${k} = $${i + 1}`).join(' AND ');
    await pg.query(`DELETE FROM ${table_name} WHERE ${where}`, keys.map(k => payload[k]));
    return;
  }

  // `synced_at` is a device-local-only column (it does not exist on any server
  // table). Some client flows leak it into the payload; strip it here so the
  // generated SQL never references a nonexistent column (which would throw and
  // strand the entry as a conflict forever).
  if (operation === 'UPDATE') {
    // Filter to real columns, strip server-controlled cols, drop attribution
    // reassignment, and reject the whole entry if it touched a sensitive column.
    const { row, rejected } = applyWritePolicy(table_name, 'UPDATE', payload, callerUserId, realColumns, can);
    if (rejected.length) throw new Error(`Forbidden columns: ${rejected.join(', ')}`);
    const hasUpdatedAt = realColumns.get(table_name)?.has('updated_at') ?? false;
    // Real partial update — only the columns the device actually changed.
    // updated_at is server-authoritative (never trust the client clock) — strip
    // any client-supplied value and force NOW() below instead.
    const cols = Object.keys(row).filter(k => k !== '__version' && k !== 'synced_at' && k !== 'updated_at' && !keys.includes(k));
    if (cols.length === 0 && !hasUpdatedAt) return;
    // Clamp absolute stock writes so a bad value can't throw the quantity >= 0
    // CHECK and strand the entry forever.
    const setParts = cols.map((c, i) => {
      const ph = `$${i + 1}`;
      return table_name === 'stock_by_location' && c === 'quantity'
        ? `${c} = GREATEST(0, ${ph})`
        : `${c} = ${ph}`;
    });
    if (hasUpdatedAt) setParts.push('updated_at = NOW()');
    const setClause = setParts.join(', ');
    const where = keys.map((k, i) => `${k} = $${cols.length + i + 1}`).join(' AND ');
    await pg.query(
      `UPDATE ${table_name} SET ${setClause} WHERE ${where}`,
      [...cols.map(c => row[c] ?? null), ...keys.map(k => payload[k])]
    );
    return;
  }

  // INSERT — full-row upsert (keyed by primary/composite key).
  // Apply the write policy first so attribution cols are forced to the caller,
  // sensitive cols reject the entry, and non-column keys are dropped; build the
  // row from the resulting policy-filtered `row`.
  const { row, rejected } = applyWritePolicy(table_name, 'INSERT', payload, callerUserId, realColumns, can);
  if (rejected.length) throw new Error(`Forbidden columns: ${rejected.join(', ')}`);
  const target = conflictTarget(table_name);
  const targetCols = new Set(keys);
  const hasUpdatedAt = realColumns.get(table_name)?.has('updated_at') ?? false;
  // updated_at is server-authoritative on INSERT too (offline created_at stays
  // client-supplied — see the activity_log rationale above — but updated_at is
  // always the server's NOW()).
  const allKeys = Object.keys(row).filter(k => k !== '__version' && k !== 'synced_at' && k !== 'updated_at');
  const cols = (hasUpdatedAt ? [...allKeys, 'updated_at'] : allKeys).join(', ');
  // Clamp absolute stock writes (both the VALUES and the DO UPDATE) with
  // GREATEST(0, …) so a bad absolute can't violate the quantity >= 0 CHECK.
  const clampStock = (k: string, ph: string) =>
    table_name === 'stock_by_location' && k === 'quantity' ? `GREATEST(0, ${ph})` : ph;
  const valParts = allKeys.map((k, i) => clampStock(k, `$${i + 1}`));
  if (hasUpdatedAt) valParts.push('NOW()');
  const vals = valParts.join(', ');
  const updateParts = allKeys
    .filter(k => !targetCols.has(k))
    .map(k => `${k} = ${clampStock(k, `$${allKeys.indexOf(k) + 1}`)}`);
  if (hasUpdatedAt) updateParts.push('updated_at = NOW()');
  const updates = updateParts.join(', ');

  const sql = updates
    ? `INSERT INTO ${table_name} (${cols}) VALUES (${vals})
       ON CONFLICT (${target}) DO UPDATE SET ${updates}`
    : `INSERT INTO ${table_name} (${cols}) VALUES (${vals})
       ON CONFLICT (${target}) DO NOTHING`;

  await pg.query(sql, allKeys.map(k => row[k] ?? null));
}

// Resolve the caller's *current* role + permission overrides from the DB — not
// the JWT role claim, which can be stale or forged-stale within the 15m token
// window. Shared by /full, /pull, and /push so all three authorize identically.
async function resolveCaller(
  pg: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
  userId: string,
): Promise<
  | { role: string; permission_overrides: Record<string, boolean> | null; role_overrides: Record<string, boolean> | null }
  | undefined
> {
  const { rows } = await pg.query(
    `SELECT u.role, u.permission_overrides, rs.permission_overrides AS role_overrides
       FROM users u
       LEFT JOIN role_settings rs ON rs.role = u.role
      WHERE u.id = $1`,
    [userId],
  );
  return rows[0] as
    | { role: string; permission_overrides: Record<string, boolean> | null; role_overrides: Record<string, boolean> | null }
    | undefined;
}

const routes: FastifyPluginAsync = async (fastify) => {
  // Boot-time column introspection — the allowlist of real identifiers per table.
  const realColumns = await loadTableColumns(fastify.pg, [...ALLOWED_TABLES]);

  // GET /sync/full — first-launch paginated full download
  fastify.get<{
    Querystring: { table?: string; page?: string; limit?: string }
  }>('/full', { preHandler: [(fastify as any).authenticate] }, async (request, reply) => {
    const { table, page = '0', limit = '500' } = request.query;
    const pageNum = parseInt(page, 10);
    const limitNum = Math.min(parseInt(limit, 10), 500);
    const offset = pageNum * limitNum;

    if (!table || !FULL_TABLES.includes(table)) {
      return reply.status(400).send({ error: 'Invalid table' });
    }

    const userId = (request.user as { sub?: string })?.sub;
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });
    const caller = await resolveCaller(fastify.pg, userId);
    if (!caller) return reply.status(403).send({ error: 'Unknown user' });
    const canViewFinancial = userHasPermission(caller.role, caller.permission_overrides, 'view_financial_data', caller.role_overrides);

    const { rows } = await fastify.pg.query(
      `SELECT ${selectColumnsFor(table, canViewFinancial)} FROM ${table} ORDER BY 1 LIMIT $1 OFFSET $2`,
      [limitNum + 1, offset]
    );

    const hasMore = rows.length > limitNum;
    return { rows: (rows as Record<string, unknown>[]).slice(0, limitNum), hasMore };
  });

  // GET /sync/pull — incremental changes since timestamp
  fastify.get<{
    Querystring: { since?: string }
  }>('/pull', { preHandler: [(fastify as any).authenticate] }, async (request, reply) => {
    const since = request.query.since ?? new Date(0).toISOString();
    const results: Record<string, { rows: unknown[] }> = {};

    const userId = (request.user as { sub?: string })?.sub;
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });
    const caller = await resolveCaller(fastify.pg, userId);
    if (!caller) return reply.status(403).send({ error: 'Unknown user' });
    const canViewFinancial = userHasPermission(caller.role, caller.permission_overrides, 'view_financial_data', caller.role_overrides);

    for (const table of FULL_TABLES) {
      const dateCol = table === 'media' ? 'created_at' : 'updated_at';
      const { rows } = await fastify.pg.query(
        `SELECT ${selectColumnsFor(table, canViewFinancial)} FROM ${table} WHERE ${dateCol} > $1`,
        [since]
      );
      results[table] = { rows };
    }

    return results;
  });

  // POST /sync/push — apply device outbox entries
  fastify.post<{ Body: PushBody }>('/push', {
    preHandler: [(fastify as any).authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['entries'],
        properties: {
          entries: { type: 'array', items: { type: 'object' } },
        },
      },
    },
  }, async (request, reply) => {
    const { entries } = request.body;
    const ok: string[] = [];
    const conflicts: Array<{ id: string; error: string }> = [];

    // Resolve the caller's *current* permissions from the DB — not the JWT role
    // claim, which can be stale or forged-stale within the 15m token window.
    const userId = (request.user as { sub?: string })?.sub;
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });
    const caller = await resolveCaller(fastify.pg, userId);
    if (!caller) return reply.status(403).send({ error: 'Unknown user' });
    const can = (perm: string) =>
      userHasPermission(caller.role, caller.permission_overrides, perm, caller.role_overrides);

    // Server-side maintenance freeze: when on, only admins (system_settings) may
    // write — mirrors the client's assertWritable() so a device with queued
    // outbox entries can't push past an admin's freeze.
    const { rows: mRows } = await fastify.pg.query(
      `SELECT value FROM app_config WHERE key = 'maintenance_mode'`,
      [],
    );
    const maintenanceOn = !!mRows[0] && (mRows[0] as { value: string }).value === '1';
    const maintenanceExempt = can('system_settings');

    for (const entry of entries) {
      if (!ALLOWED_TABLES.has(entry.table_name)) {
        conflicts.push({ id: entry.id, error: 'Table not allowed' });
        continue;
      }

      if (maintenanceOn && !maintenanceExempt) {
        conflicts.push({ id: entry.id, error: 'Maintenance mode: writes are frozen' });
        continue;
      }

      // Privileged-table authorization — block escalation via crafted outbox rows.
      const reqPerm = PRIVILEGED_TABLE_PERM[entry.table_name];
      if (reqPerm && !can(reqPerm)) {
        request.log.warn(
          { userId, role: caller.role, table: entry.table_name, operation: entry.operation, reqPerm },
          'sync push entry denied (authz)',
        );
        conflicts.push({ id: entry.id, error: `Forbidden: ${entry.table_name} requires ${reqPerm}` });
        continue;
      }

      // Privileged rows are never DELETED via sync: users deactivate (active=false),
      // not delete; roles/config persist. Without this, a manage_users holder (e.g. a
      // tier-3 hr_manager) could remove a full_admin row via a crafted DELETE entry —
      // a capability the REST API deliberately never exposes.
      if (entry.operation === 'DELETE' && DELETE_FORBIDDEN_TABLES.has(entry.table_name)) {
        conflicts.push({ id: entry.id, error: `Forbidden: ${entry.table_name} cannot be deleted via sync` });
        continue;
      }

      // Operational-table authorization — gate writes on the per-operation
      // permission. ADJUST is the signed-delta checkout/checkin path on
      // stock_by_location; it requires checkin_inventory or checkout_inventory
      // rather than the generic op-perm map (any authenticated user was
      // previously able to mutate stock via ADJUST — closed here).
      if (entry.operation === 'ADJUST') {
        if (!can('checkin_inventory') && !can('checkout_inventory')) {
          request.log.warn(
            { userId, role: caller.role, table: entry.table_name, operation: entry.operation },
            'sync push ADJUST denied (authz)',
          );
          conflicts.push({ id: entry.id, error: 'Forbidden: stock adjust requires checkin/checkout permission' });
          continue;
        }
      } else if (entry.table_name === 'inventory_items' && entry.operation === 'UPDATE' && entry.payload.active === false) {
        // Deactivating an item IS the delete (items are soft-deleted, never row-
        // deleted). The generic UPDATE op-perm is only `edit_inventory`, so gate
        // the active:false case on the stricter `delete_inventory` — otherwise the
        // UI's delete gate would be advisory-only and an edit_inventory-only role
        // could deactivate items via a crafted push.
        if (!can('delete_inventory')) {
          conflicts.push({ id: entry.id, error: 'Forbidden: deactivating an item requires delete_inventory' });
          continue;
        }
      } else {
        const opPerm = requiredOperationPerm(entry.table_name, entry.operation as 'INSERT' | 'UPDATE' | 'DELETE');
        if (opPerm === 'DENY') {
          conflicts.push({ id: entry.id, error: `Forbidden: ${entry.table_name}/${entry.operation} not permitted via sync` });
          continue;
        }
        if (opPerm && !can(opPerm)) {
          request.log.warn(
            { userId, role: caller.role, table: entry.table_name, operation: entry.operation, opPerm },
            'sync push op denied (authz)',
          );
          conflicts.push({ id: entry.id, error: `Forbidden: ${entry.table_name}/${entry.operation} requires ${opPerm}` });
          continue;
        }
      }

      // Target-role guard for users writes: applyWritePolicy above already gates
      // WHICH columns a manage_users-only caller may set, but not WHOSE row. A
      // manage_users holder without manage_roles_permissions must not be able to
      // deactivate/expire a full_admin/franchise_manager via a crafted outbox
      // entry — REST PATCH /users/:id already blocks the equivalent via
      // PRIVILEGED_ROLES (apps/api/src/routes/users.ts). DELETE on users is
      // already unconditionally forbidden above; INSERT is an upsert
      // (ON CONFLICT DO UPDATE) so it must be guarded too, not just UPDATE.
      if (entry.table_name === 'users' && (entry.operation === 'UPDATE' || entry.operation === 'INSERT')) {
        const targetId = entry.payload.id;
        const { rows: targetRows } = await fastify.pg.query(
          `SELECT role, active FROM users WHERE id = $1`,
          [targetId],
        );
        const target = targetRows[0] as { role: string; active: boolean } | undefined;
        if (target) {
          if (requiresRolesPermForTarget(target.role) && !can('manage_roles_permissions')) {
            request.log.warn(
              { userId, role: caller.role, targetId, targetRole: target.role },
              'sync push users update denied (target-role guard)',
            );
            conflicts.push({ id: entry.id, error: 'Forbidden: target user has a privileged role; requires roles & permissions' });
            continue;
          }
          // "Deactivating" = explicit active:false OR pushing expires_at into the
          // past (login enforces expires_at, so a past date locks the account out).
          const exp = entry.payload.expires_at;
          const expiredOut = exp != null && !Number.isNaN(Date.parse(String(exp))) && new Date(String(exp)) < new Date();
          const deactivating = entry.payload.active === false || expiredOut;
          if (deactivating && targetId === userId) {
            conflicts.push({ id: entry.id, error: 'Forbidden: you cannot deactivate your own account' });
            continue;
          }
          if (deactivating && target.active && target.role === 'full_admin') {
            const { rows: activeAdminRows } = await fastify.pg.query(
              `SELECT COUNT(*)::int AS n FROM users WHERE role = 'full_admin' AND active = true`,
              [],
            );
            const activeAdminCount = (activeAdminRows[0] as { n: number }).n;
            if (activeAdminCount <= 1) {
              conflicts.push({ id: entry.id, error: 'Forbidden: cannot deactivate the last active full_admin' });
              continue;
            }
          }
        }
      }

      try {
        await applyEntry(fastify.pg, entry, userId, realColumns, can);
        ok.push(entry.id);
      } catch (err) {
        // Log the offending entry so a stuck/rejected outbox row is diagnosable
        // (the client only stores the reason locally; conflicts aren't otherwise
        // visible server-side). Include table + operation + payload keys.
        request.log.warn(
          {
            entryId: entry.id,
            table: entry.table_name,
            operation: entry.operation,
            payloadKeys: entry.payload ? Object.keys(entry.payload) : [],
            error: (err as Error).message,
          },
          'sync push entry rejected',
        );
        conflicts.push({ id: entry.id, error: (err as Error).message });
      }
    }

    if (conflicts.length > 0) {
      request.log.warn({ count: conflicts.length }, 'sync push had conflicts');
    }

    return { ok, conflicts };
  });
};

export default routes;
