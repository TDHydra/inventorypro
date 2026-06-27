import { FastifyPluginAsync } from 'fastify';

interface OutboxEntry {
  id: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
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
  'equipment_units', 'app_config', 'taxonomy_types',
]);

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
  'equipment_units', 'app_config', 'taxonomy_types',
];

// Columns synced to devices, per table. Sensitive fields (e.g. users.pin_hash)
// are deliberately NOT sent — PIN verification happens server-side only, so the
// device never holds an extractable credential. Tables not listed sync with '*'.
const SELECT_COLUMNS: Record<string, string> = {
  users: 'id, name, role, pin_length_required, pin_set, permission_overrides, active, expires_at, created_at, updated_at',
};

function selectColsFor(table: string): string {
  return SELECT_COLUMNS[table] ?? '*';
}

async function applyEntry(
  pg: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
  entry: OutboxEntry
): Promise<void> {
  const { operation, table_name, payload } = entry;

  // activity_log is append-only (enforced by Postgres RULES). ON CONFLICT is
  // incompatible with rules, so insert idempotently via WHERE NOT EXISTS.
  if (table_name === 'activity_log') {
    if (operation !== 'INSERT') return;
    await pg.query(
      `INSERT INTO activity_log
         (id, user_id, team_id, action, entity_type, entity_id,
          from_location_id, to_location_id, quantity, unit,
          job_id, note, metadata, device_id, created_at, synced_at,
          latitude, longitude, location_accuracy)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW(),$16,$17,$18
       WHERE NOT EXISTS (SELECT 1 FROM activity_log WHERE id = $1)`,
      [
        payload.id, payload.user_id ?? null, payload.team_id ?? null,
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
    // Real partial update — only the columns the device actually changed.
    const cols = Object.keys(payload).filter(k => k !== '__version' && k !== 'synced_at' && !keys.includes(k));
    if (cols.length === 0) return;
    const setClause = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const where = keys.map((k, i) => `${k} = $${cols.length + i + 1}`).join(' AND ');
    await pg.query(
      `UPDATE ${table_name} SET ${setClause} WHERE ${where}`,
      [...cols.map(c => payload[c] ?? null), ...keys.map(k => payload[k])]
    );
    return;
  }

  // INSERT — full-row upsert (keyed by primary/composite key).
  const target = conflictTarget(table_name);
  const targetCols = new Set(keys);
  const allKeys = Object.keys(payload).filter(k => k !== '__version' && k !== 'synced_at');
  const cols = allKeys.join(', ');
  const vals = allKeys.map((_, i) => `$${i + 1}`).join(', ');
  const updates = allKeys
    .filter(k => !targetCols.has(k))
    .map(k => `${k} = $${allKeys.indexOf(k) + 1}`)
    .join(', ');

  const sql = updates
    ? `INSERT INTO ${table_name} (${cols}) VALUES (${vals})
       ON CONFLICT (${target}) DO UPDATE SET ${updates}`
    : `INSERT INTO ${table_name} (${cols}) VALUES (${vals})
       ON CONFLICT (${target}) DO NOTHING`;

  await pg.query(sql, allKeys.map(k => payload[k] ?? null));
}

const routes: FastifyPluginAsync = async (fastify) => {
  // GET /sync/full — first-launch paginated full download
  fastify.get<{
    Querystring: { table?: string; page?: string; limit?: string }
  }>('/full', async (request, reply) => {
    const { table, page = '0', limit = '500' } = request.query;
    const pageNum = parseInt(page, 10);
    const limitNum = Math.min(parseInt(limit, 10), 500);
    const offset = pageNum * limitNum;

    if (!table || !FULL_TABLES.includes(table)) {
      return reply.status(400).send({ error: 'Invalid table' });
    }

    const { rows } = await fastify.pg.query(
      `SELECT ${selectColsFor(table)} FROM ${table} ORDER BY 1 LIMIT $1 OFFSET $2`,
      [limitNum + 1, offset]
    );

    const hasMore = rows.length > limitNum;
    return { rows: (rows as Record<string, unknown>[]).slice(0, limitNum), hasMore };
  });

  // GET /sync/pull — incremental changes since timestamp
  fastify.get<{
    Querystring: { since?: string }
  }>('/pull', { preHandler: [(fastify as any).authenticate] }, async (request) => {
    const since = request.query.since ?? new Date(0).toISOString();
    const results: Record<string, { rows: unknown[] }> = {};

    for (const table of FULL_TABLES) {
      const col = table === 'team_members' ? 'joined_at' : 'updated_at';
      const hasUpdatedAt = !['media'].includes(table) || col === 'joined_at';
      const dateCol = table === 'media' ? 'created_at' : col;
      const { rows } = await fastify.pg.query(
        `SELECT ${selectColsFor(table)} FROM ${table} WHERE ${dateCol} > $1`,
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
  }, async (request) => {
    const { entries } = request.body;
    const ok: string[] = [];
    const conflicts: Array<{ id: string; error: string }> = [];

    for (const entry of entries) {
      if (!ALLOWED_TABLES.has(entry.table_name)) {
        conflicts.push({ id: entry.id, error: 'Table not allowed' });
        continue;
      }

      try {
        await applyEntry(fastify.pg, entry);
        ok.push(entry.id);
      } catch (err) {
        conflicts.push({ id: entry.id, error: (err as Error).message });
      }
    }

    return { ok, conflicts };
  });
};

export default routes;
