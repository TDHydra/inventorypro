import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  buildAuditRow, shouldAudit, outcomeFor,
  AUDIT_RETAIN_DAYS, AUDIT_RETAIN_SECURITY_DAYS,
} from './audit';

// Writes api_request_audit rows (migration 042) and prunes them.
//
// Never reads request.body or the Authorization header — see the invariant in
// lib/audit.ts. This file only resolves the ACTOR (id/name/role) and inserts.

// Actor name/role are snapshotted onto every row so a deleted user stays
// identifiable (user_id is ON DELETE SET NULL). Looking them up per request
// would add a query to every call, so memoize briefly. A stale name for 60s is
// harmless; this cache is never used for an authorization decision.
const ACTOR_TTL_MS = 60_000;
const actorCache = new Map<string, { name: string | null; role: string | null; at: number }>();

async function resolveActor(
  fastify: FastifyInstance,
  request: FastifyRequest,
): Promise<{ id: string | null; name: string | null; role: string | null }> {
  // request.user is populated only on routes that ran `authenticate`. A request
  // that 429'd in the global preHandler, or hit a public/failed-auth route, has
  // no user — but may still carry a valid token. Verify without throwing so we
  // keep attribution on exactly the requests an audit most needs it for.
  let sub: string | undefined = (request.user as { sub?: string } | undefined)?.sub;
  if (!sub) {
    try { sub = ((await request.jwtVerify()) as { sub?: string })?.sub; } catch { sub = undefined; }
  }
  if (!sub) return { id: null, name: null, role: null };

  const hit = actorCache.get(sub);
  // Date.now() is fine here (runtime, not a workflow script).
  const now = Date.now();
  if (hit && now - hit.at < ACTOR_TTL_MS) return { id: sub, name: hit.name, role: hit.role };

  try {
    const { rows } = await fastify.pg.query<{ name: string; role: string }>(
      `SELECT name, role FROM users WHERE id = $1`, [sub],
    );
    const name = rows[0]?.name ?? null;
    const role = rows[0]?.role ?? null;
    actorCache.set(sub, { name, role, at: now });
    return { id: sub, name, role };
  } catch {
    return { id: sub, name: null, role: null };
  }
}

// Fire-and-forget: called from onResponse (after the client already has its
// response). Deliberately not awaited by the hook and never throws — an audit
// failure must not surface as a request failure.
export function recordAudit(
  fastify: FastifyInstance,
  request: FastifyRequest,
  statusCode: number,
  elapsedMs: number,
): void {
  // Stashed by the global error handler — a boolean, never the offending body.
  const validationReject =
    !!(request as unknown as { auditValidationReject?: boolean }).auditValidationReject;
  const outcome = outcomeFor(statusCode, validationReject);
  if (!shouldAudit(request.method, request.url, outcome)) return;

  void (async () => {
    try {
      const actor = await resolveActor(fastify, request);
      const err = (request as unknown as { auditError?: string | null }).auditError ?? null;
      const r = buildAuditRow(request, statusCode, elapsedMs, actor, err, validationReject);
      await fastify.pg.query(
        `INSERT INTO api_request_audit
           (request_id, user_id, actor_name, actor_role, method, route, path,
            status_code, outcome, duration_ms, ip, user_agent, device_id,
            platform, app_version, error_message, security_class)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          r.request_id, r.user_id, r.actor_name, r.actor_role, r.method, r.route, r.path,
          r.status_code, r.outcome, r.duration_ms, r.ip, r.user_agent, r.device_id,
          r.platform, r.app_version, r.error_message, r.security_class,
        ],
      );
    } catch (e) {
      fastify.log.warn({ err: e }, 'audit write failed');
    }
  })();
}

// Batched delete: an append-heavy table pruned with one giant DELETE generates
// dead tuples faster than autovacuum reclaims them. Loop in chunks instead.
async function pruneOnce(fastify: FastifyInstance): Promise<number> {
  let total = 0;
  for (const [days, sec] of [[AUDIT_RETAIN_DAYS, false], [AUDIT_RETAIN_SECURITY_DAYS, true]] as const) {
    for (;;) {
      const { rowCount } = await fastify.pg.query(
        `DELETE FROM api_request_audit WHERE ctid IN (
           SELECT ctid FROM api_request_audit
            WHERE security_class = $2 AND occurred_at < NOW() - ($1 || ' days')::INTERVAL
            LIMIT 5000)`,
        [String(days), sec],
      );
      total += rowCount ?? 0;
      if (!rowCount) break;
    }
  }
  return total;
}

// Boot-time pruning alone never runs in practice — prod restarts are rare and
// this table grows per request. Run it on a daily timer too.
export function startAuditPruneTimer(fastify: FastifyInstance): NodeJS.Timeout {
  const run = () => {
    pruneOnce(fastify)
      .then(n => { if (n) fastify.log.info(`pruned ${n} api_request_audit row(s)`); })
      .catch(e => fastify.log.warn({ err: e }, 'audit prune failed'));
  };
  run();
  const t = setInterval(run, 24 * 60 * 60 * 1000);
  t.unref();
  return t;
}
