import { FastifyPluginAsync } from 'fastify';
import { overRateLimit } from '../lib/rateLimit';
import { sanitizeEvent } from '../lib/telemetry';

// POST /telemetry — batched, fire-and-forget behavioral event ingest.
// Authenticated (so events can be attributed to a user) but deliberately
// tolerant: a malformed event is dropped, never fails the whole batch, and
// there's no read endpoint here — dashboards query telemetry_events directly
// (see docs/telemetry-queries.md). Never pulled back to devices.
const routes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: { events?: unknown[] } }>('/', {
    preHandler: [(fastify as any).authenticate],
    schema: { body: { type: 'object', required: ['events'],
      properties: { events: { type: 'array', maxItems: 100, items: { type: 'object' } } } } },
  }, async (request, reply) => {
    const userId = (request.user as { sub?: string })?.sub ?? null;
    if (overRateLimit(`telemetry:${userId ?? request.ip}`)) return reply.status(429).send({ error: 'rate' });
    const sid = (request.headers['x-telemetry-session'] as string || 'anon').slice(0, 64);
    const dev = (request.headers['x-telemetry-device'] as string || null)?.slice(0, 64) ?? null;
    const plat = (request.headers['x-telemetry-platform'] as string || null)?.slice(0, 20) ?? null;
    const ver = (request.headers['x-telemetry-appver'] as string || null)?.slice(0, 40) ?? null;
    let accepted = 0;
    for (const raw of request.body.events ?? []) {
      const e = sanitizeEvent(raw);
      if (!e) continue;
      try {
        await fastify.pg.query(
          `INSERT INTO telemetry_events (session_id,user_id,device_id,platform,app_version,type,name,screen,props,client_ts)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [sid, userId, dev, plat, ver, e.type, e.name, e.screen, JSON.stringify(e.props), e.client_ts],
        );
        accepted++;
      } catch { /* fire-and-forget: never fail the batch on one bad row */ }
    }
    return { accepted };
  });
};
export default routes;
