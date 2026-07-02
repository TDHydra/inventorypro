import { FastifyPluginAsync } from 'fastify';
import { overRateLimit, overLimit } from '../lib/rateLimit';
import { ingestEvents } from '../lib/telemetry';

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
};
export default routes;
