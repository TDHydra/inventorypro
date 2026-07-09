import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyPostgres from '@fastify/postgres';
import fastifyCors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { runMigrations } from './db/migrate';
import { overRateLimit } from './lib/rateLimit';
import { startNotificationTimer } from './lib/notificationTimer';
import { recordAudit, startAuditPruneTimer } from './lib/auditWriter';
import { sanitizeErrorMessage } from './lib/audit';

import authRoutes from './routes/auth';
import syncRoutes from './routes/sync';
import itemRoutes from './routes/items';
import locationRoutes from './routes/locations';
import jobRoutes from './routes/jobs';
import teamRoutes from './routes/teams';
import userRoutes from './routes/users';
import logRoutes from './routes/logs';
import mediaRoutes from './routes/media';
import labelRoutes from './routes/labels';
import telemetryRoutes from './routes/telemetry';
import pushRoutes from './routes/push';
import notificationsRoutes from './routes/notifications';
import auditRoutes from './routes/audit';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

// Resolved once at boot. 'unknown' (not a plausible-looking version) so a broken
// read is visibly broken rather than silently reporting a stale number.
const API_VERSION: string = (() => {
  try {
    const pkg = readFileSync(join(__dirname, '..', 'package.json'), 'utf8');
    return (JSON.parse(pkg) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
  // A real correlation id instead of Fastify's process-local integer reqId
  // (req-1, req-2… which resets every restart and means nothing to a client).
  // Echoed back as X-Request-Id and stored on every audit row, so a support
  // ticket quoting an id can be traced straight to the request and the
  // activity_log rows it produced.
  genReqId: () => randomUUID(),
  // Behind the NPM reverse proxy, request.ip is otherwise always the proxy's
  // IP — collapsing all clients onto one IP-keyed rate-limit bucket. Trust
  // X-Forwarded-For so request.ip reflects the real client. Pinned to the
  // proxy's own address/subnet (not `true`, which would trust ANY caller's
  // X-Forwarded-For — trivially spoofable to bypass IP-keyed rate limiting).
  // TRUST_PROXY should be set to the NPM/Docker bridge subnet (e.g.
  // 172.18.0.0/16) in prod .env; the loopback default keeps local dev booting.
  trustProxy: process.env.TRUST_PROXY ?? '127.0.0.1',
});

async function build() {
  // CORS — allowlist instead of reflecting any Origin. Native apps send no Origin
  // (fetch omits it) → allowed; browser origins must match the configured web
  // host(s) or localhost (dev). Override/extend via CORS_ORIGINS (comma-separated).
  const allowedOrigins = (process.env.CORS_ORIGINS ?? 'https://invenpro.app')
    .split(',').map(s => s.trim()).filter(Boolean);
  await fastify.register(fastifyCors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // native app / curl / same-origin
      if (allowedOrigins.includes(origin) || /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
        return cb(null, true);
      }
      cb(null, false);
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    // Without this the split-origin web client (invenpro.app → api.invenpro.app)
    // cannot read X-Request-Id off the response: CORS hides non-safelisted
    // response headers from JS unless they are explicitly exposed.
    exposedHeaders: ['X-Request-Id'],
  });

  // Security headers. CSP off: this is a JSON+image API (no server-rendered
  // HTML), and a default CSP can break presigned-image hosts / the web client's
  // fetches without adding meaningful protection here. crossOriginResourcePolicy
  // is relaxed to 'cross-origin': helmet's default 'same-origin' blocks the
  // split-origin web client (invenpro.app) from reading responses
  // from this API (api.invenpro.app) even though CORS above allows it —
  // CORP is enforced by the browser independently of CORS.
  await fastify.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  // Postgres
  await fastify.register(fastifyPostgres, {
    connectionString: process.env.DATABASE_URL,
  });

  // JWT — refuse to boot on a missing/weak secret (HS256 needs real entropy, else
  // tokens are forgeable). Better to fail loudly at startup than run insecure.
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be set and at least 32 characters.');
  }
  await fastify.register(fastifyJwt, {
    secret: jwtSecret,
    sign: { expiresIn: '15m' },
  });

  // Auth decorator — verifies JWT on protected routes
  fastify.decorate('authenticate', async function (request: any, reply: any) {
    try {
      await request.jwtVerify();
    } catch {
      reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  // Surface the correlation id to the caller on every response, including errors.
  fastify.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
  });

  // API access/audit trail (migration 042). Runs AFTER the response is sent, so
  // it adds no latency to the request; the write is fire-and-forget and can
  // never fail a request. Reads nothing but method/url/status/timing/ip and the
  // user-agent + X-Telemetry-* headers — never the body or Authorization.
  fastify.addHook('onResponse', async (request, reply) => {
    recordAudit(fastify, request, reply.statusCode, reply.elapsedTime);
  });

  // Per-user DOS guard on mutating endpoints (generous). /auth has its own
  // limiter and is public, so it's skipped. Unauthenticated requests fall
  // through to the route's own auth (which rejects them).
  fastify.addHook('preHandler', async (request: any, reply: any) => {
    const m = request.method;
    if (m !== 'POST' && m !== 'PATCH' && m !== 'DELETE') return;
    if (request.url.startsWith('/auth')) return;
    // /telemetry has its OWN per-user/IP `telemetry:` bucket (routes/telemetry.ts)
    // and is fire-and-forget behavioral ingest — never let a telemetry flush burst
    // consume a user's business `mut:` (/sync/push) quota.
    if (request.url.startsWith('/telemetry')) return;
    let sub: string | undefined;
    try { sub = (await request.jwtVerify())?.sub; } catch { return; }
    if (sub && overRateLimit(`mut:${sub}`)) {
      return reply.status(429).send({ error: 'Too many requests. Please slow down and try again.' });
    }
  });

  // Routes
  await fastify.register(authRoutes, { prefix: '/auth' });
  await fastify.register(syncRoutes, { prefix: '/sync' });
  await fastify.register(itemRoutes, { prefix: '/items' });
  await fastify.register(locationRoutes, { prefix: '/locations' });
  await fastify.register(jobRoutes, { prefix: '/jobs' });
  await fastify.register(teamRoutes, { prefix: '/teams' });
  await fastify.register(userRoutes, { prefix: '/users' });
  await fastify.register(logRoutes, { prefix: '/logs' });
  await fastify.register(mediaRoutes, { prefix: '/media' });
  await fastify.register(labelRoutes, { prefix: '/labels' });
  await fastify.register(telemetryRoutes, { prefix: '/telemetry' });
  await fastify.register(pushRoutes, { prefix: '/push' });
  await fastify.register(notificationsRoutes, { prefix: '/notifications' });
  await fastify.register(auditRoutes, { prefix: '/audit' });

  // Health check — includes uptime and version for ops dashboards.
  //
  // Read the version from package.json rather than npm_package_version: npm only
  // sets that variable when Node is launched THROUGH an npm/pnpm script, and the
  // Dockerfile's CMD is `node apps/api/dist/index.js` directly. Relying on it meant
  // /health always reported the hardcoded fallback, so a version bump looked like a
  // failed deploy. `../package.json` resolves under both dist/ (prod) and src/ (dev).
  fastify.get('/health', async () => ({
    ok: true,
    ts: new Date().toISOString(),
    version: API_VERSION,
    uptime: Math.floor(process.uptime()),
  }));

  // Global error handler — never leak internal error detail (stack traces,
  // SQL errors, etc.) on 5xx. Intentional 4xx messages (validation, auth) are
  // preserved since routes rely on those being visible to the client.
  fastify.setErrorHandler((err, request, reply) => {
    request.log.error({ err }, 'request error');
    const status = (err as any).statusCode ?? 500;
    // Stash a sanitized reason for the onResponse audit hook. For 5xx this is
    // the error's class name only — never the message, stack, or SQL/driver
    // text, matching what we refuse to send the client below. sanitizeErrorMessage
    // also drops /auth 4xx messages, which can echo submitted field context.
    (request as any).auditError = status >= 500
      ? (err.name || 'Error')
      : sanitizeErrorMessage(request.url, status, err.message);
    if (status >= 500) return reply.status(status).send({ error: 'Internal Server Error' });
    return reply.status(status).send({ error: err.message });
  });

  return fastify;
}

runMigrations()
  .then(() => build())
  .then(app => {
    app.listen({ port: PORT, host: HOST }, (err) => {
      if (err) {
        app.log.error(err);
        process.exit(1);
      }
      // Start the notification timer (checkout-idle etc.) once we're serving.
      startNotificationTimer(app.pg);
      // Prune api_request_audit now and daily. Boot-only pruning would never
      // fire in practice — prod restarts are rare and this table grows per request.
      startAuditPruneTimer(app);
    });
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
