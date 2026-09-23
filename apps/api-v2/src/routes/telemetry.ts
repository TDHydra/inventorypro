import { FastifyPluginAsync } from 'fastify';
import { overRateLimit, overLimit } from '../lib/rateLimit';
import { ingestEvents, getTelemetrySummary } from '../lib/telemetry';
import { requirePermission } from '../lib/permissions';

// POST /telemetry — batched, fire-and-forget behavioral event ingest.
// Auth is OPTIONAL: a valid bearer attributes events to a user; without one we
// still accept the batch anonymously (user_id NULL) so the first-launch /
// login-screen funnel is captured. To keep that public path from becoming an
// abuse surface it's (a) tightly IP-rate-limited for anonymous callers, (b)
// bounded to maxItems events, and (c) run through sanitizeEvent (strict type +
// prop allowlist, no free text) — a malformed event is dropped, never fails the
// batch. No read endpoint; dashboards query telemetry_events directly.
const routes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: { events?: unknown[] } }>('/', {
    schema: { body: { type: 'object', required: ['events'],
      properties: { events: { type: 'array', maxItems: 100, items: { type: 'object' } } } } },
  }, async (request, reply) => {
    // Optional auth: verify a bearer if present; anonymous otherwise (never 401).
    let userId: string | null = null;
    try { userId = (await request.jwtVerify() as { sub?: string })?.sub ?? null; } catch { userId = null; }
    // Authenticated callers key on their user id (shared 120/min); anonymous
    // callers get a much tighter per-IP ceiling so an open endpoint can't be
    // used to flood telemetry_events.
    const overLimitHit = userId
      ? overRateLimit(`telemetry:${userId}`)
      : overLimit(`telemetry-anon:${request.ip}`, 30);
    if (overLimitHit) return reply.status(429).send({ error: 'rate' });
    const sid = (request.headers['x-telemetry-session'] as string || 'anon').slice(0, 64);
    const dev = (request.headers['x-telemetry-device'] as string || null)?.slice(0, 64) ?? null;
    const plat = (request.headers['x-telemetry-platform'] as string || null)?.slice(0, 20) ?? null;
    const ver = (request.headers['x-telemetry-appver'] as string || null)?.slice(0, 40) ?? null;
    const accepted = await ingestEvents(fastify.pg, request.body.events ?? [], {
      sessionId: sid, userId, deviceId: dev, platform: plat, appVersion: ver,
    });
    return { accepted };
  });

  // GET /telemetry/summary — aggregate analytics for the admin Insights screen.
  // Gated on system_settings (full_admin floor; grantable via overrides). The
  // ONLY read path into telemetry_events. `days` clamped to the 90d retention.
  fastify.get<{ Querystring: { days?: number } }>('/summary', {
    preHandler: [(fastify as any).authenticate, requirePermission('system_settings')],
    schema: { querystring: { type: 'object',
      properties: { days: { type: 'integer', minimum: 1, maximum: 90 } } } },
  }, async (request) => {
    const days = Math.min(90, Math.max(1, Number(request.query.days) || 7));
    return getTelemetrySummary(fastify.pg, days);
  });
};
export default routes;
