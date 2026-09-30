import { FastifyPluginAsync } from 'fastify';
import { userHasPermission, effectiveTier } from '../lib/permissions';
import { isAuditDebug, setAuditDebug } from '../lib/audit';
import { createDemoModeGate, DemoModeGate } from '../lib/demoMode';
import { UUID_SCHEMA } from '../lib/schemaShapes';

// Admin read surface for the API access/audit trail (migration 042).
// Gated on `view_audit_log`. Raw PII (ip / user_agent / device) is returned only
// to a full_admin — and the tier is resolved from the DB, never from the JWT
// role claim, which a stale 15-minute token could otherwise carry.

const auth = { preHandler: [] as any[] };

interface ListQuery {
  outcome?: string;
  user_id?: string;
  method?: string;
  q?: string;
  security_only?: boolean;
  before_ts?: string;   // keyset cursor
  before_id?: string;
  limit?: number;
}

export interface AuditRoutesOpts {
  // Shared with routes/auth.ts (see index.ts) so a PATCH here invalidates the
  // SAME cache the roster/set-pin checks read — not a second instance whose
  // stale value would linger a full TTL.
  demoGate?: DemoModeGate;
}

const routes: FastifyPluginAsync<AuditRoutesOpts> = async (fastify, opts) => {
  auth.preHandler = [(fastify as any).authenticate];
  const demoGate = opts.demoGate ?? createDemoModeGate({
    query: (sql, params) => fastify.pg.query(sql, params as any[]),
  });

  // Resolve the caller's role from the DB (authoritative) and confirm the
  // permission. Returns null after replying 403.
  async function gate(request: any, reply: any): Promise<{ role: string; isApex: boolean } | null> {
    const callerId = (request.user as { sub: string }).sub;
    const { rows } = await fastify.pg.query(
      `SELECT u.role, u.permission_overrides, rs.permission_overrides AS role_overrides
         FROM users u LEFT JOIN role_settings rs ON rs.role = u.role
        WHERE u.id = $1`,
      [callerId],
    );
    const u = rows[0];
    if (!u || !userHasPermission(u.role, u.permission_overrides, 'view_audit_log', u.role_overrides)) {
      reply.status(403).send({ error: 'Forbidden' });
      return null;
    }
    return { role: u.role, isApex: effectiveTier(u.role) === 5 };
  }

  // GET /audit — newest first, keyset paginated on (occurred_at, id).
  fastify.get<{ Querystring: ListQuery }>('/', {
    ...auth,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          outcome: { type: 'string', enum: ['success', 'denied', 'rate_limited', 'client_error', 'server_error', 'validation_reject'] },
          user_id: UUID_SCHEMA,
          method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'DELETE'] },
          q: { type: 'string', maxLength: 200 },
          security_only: { type: 'boolean' },
          before_ts: { type: 'string' },
          before_id: UUID_SCHEMA,
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
      },
    },
  }, async (request, reply) => {
    const g = await gate(request, reply);
    if (!g) return;

    const q = request.query;
    const where: string[] = [];
    const vals: unknown[] = [];
    const add = (sql: string, v: unknown) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); };

    if (q.outcome) add('outcome = ?', q.outcome);
    if (q.user_id) add('user_id = ?', q.user_id);
    if (q.method) add('method = ?', q.method);
    if (q.security_only) where.push('security_class');
    // Prefix match, not a leading-wildcard ILIKE: `%foo%` cannot use an index and
    // would sequential-scan a table that grows by one row per request.
    if (q.q) {
      vals.push(`${q.q}%`, `${q.q}%`);
      where.push(`(path LIKE $${vals.length - 1} OR route LIKE $${vals.length})`);
    }

    // Keyset cursor: strictly older than (before_ts, before_id).
    if (q.before_ts && q.before_id) {
      vals.push(q.before_ts, q.before_id);
      where.push(`(occurred_at, id) < ($${vals.length - 1}::timestamptz, $${vals.length}::uuid)`);
    }

    const limit = q.limit ?? 50;
    vals.push(limit);

    const apex = g.isApex;
    const { rows } = await fastify.pg.query(
      `SELECT id, request_id, occurred_at, user_id, actor_name, actor_role,
              method, route, path, status_code, outcome, duration_ms,
              ${apex ? 'ip, user_agent, device_id, platform, app_version' :
                       'NULL AS ip, NULL AS user_agent, NULL AS device_id, platform, app_version'},
              error_message, security_class
         FROM api_request_audit
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY occurred_at DESC, id DESC
        LIMIT $${vals.length}`,
      vals,
    );

    const last = rows[rows.length - 1];
    return {
      rows,
      // Non-apex callers get actor/action/outcome/time; ip+device are masked.
      masked: !apex,
      debug: isAuditDebug(),
      next: rows.length === limit && last
        ? { before_ts: last.occurred_at, before_id: last.id }
        : null,
    };
  });

  // GET /audit/:requestId/activity — the business actions this HTTP request
  // produced. Only SERVER-written activity (login, pin_set) is correlated to its
  // own request. Rows the client created offline and later pushed correlate to
  // the /sync/push request that carried them, NOT to the moment they happened —
  // the UI must label them as such (see `pushed` below).
  fastify.get<{ Params: { requestId: string } }>('/:requestId/activity', {
    ...auth,
    schema: {
      params: {
        type: 'object',
        required: ['requestId'],
        properties: { requestId: UUID_SCHEMA },
      },
    },
  }, async (request, reply) => {
    const g = await gate(request, reply);
    if (!g) return;
    const { rows } = await fastify.pg.query(
      `SELECT id, action, entity_type, entity_id, note, created_at, metadata
         FROM activity_log
        WHERE metadata->>'request_id' = $1
        ORDER BY created_at ASC
        LIMIT 200`,
      [request.params.requestId],
    );
    return { rows };
  });

  // GET/PATCH /audit/debug — verbose capture toggle. Debug mode records EVERY
  // request including the /sync/pull + /sync/full polls every device makes
  // continuously, so it is off by default and full_admin only. In-memory: it
  // resets on restart by design.
  fastify.get('/debug', { ...auth }, async (request, reply) => {
    const g = await gate(request, reply);
    if (!g) return;
    return { debug: isAuditDebug() };
  });

  fastify.patch<{ Body: { debug: boolean } }>('/debug', {
    ...auth,
    schema: {
      body: { type: 'object', required: ['debug'], properties: { debug: { type: 'boolean' } } },
    },
  }, async (request, reply) => {
    const g = await gate(request, reply);
    if (!g) return;
    if (!g.isApex) return reply.status(403).send({ error: 'Only a full admin can change audit debug mode.' });
    return { debug: setAuditDebug(request.body.debug) };
  });

  // GET/PATCH /audit/demo-mode — kill switch for the public demo accounts
  // (app_config.demo_mode, migration 047). OFF hides demo accounts from the
  // login roster and blocks their /auth/set-pin enrollment. Persisted (unlike
  // /audit/debug): whether strangers can enter the demo sandbox must survive a
  // restart. Missing row → ON, matching the migration seed.
  fastify.get('/demo-mode', { ...auth }, async (request, reply) => {
    const g = await gate(request, reply);
    if (!g) return;
    return { enabled: await demoGate.isEnabled() };
  });

  fastify.patch<{ Body: { enabled: boolean } }>('/demo-mode', {
    ...auth,
    schema: {
      body: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } },
    },
  }, async (request, reply) => {
    const g = await gate(request, reply);
    if (!g) return;
    if (!g.isApex) return reply.status(403).send({ error: 'Only a full admin can change demo mode.' });
    await fastify.pg.query(
      `INSERT INTO app_config (key, value, updated_at)
       VALUES ('demo_mode', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [request.body.enabled ? '1' : '0'],
    );
    demoGate.invalidate();
    return { enabled: request.body.enabled };
  });
};

export default routes;
