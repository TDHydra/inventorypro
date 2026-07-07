import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyPostgres from '@fastify/postgres';
import fastifyCors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { runMigrations } from './db/migrate';
import { overRateLimit } from './lib/rateLimit';
import { startNotificationTimer } from './lib/notificationTimer';

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

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
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

  // Health check — includes uptime and version for ops dashboards.
  // npm_package_version is set automatically when started via pnpm/npm run scripts.
  const apiVersion = process.env.npm_package_version ?? '1.0.0';
  fastify.get('/health', async () => ({
    ok: true,
    ts: new Date().toISOString(),
    version: apiVersion,
    uptime: Math.floor(process.uptime()),
  }));

  // Global error handler — never leak internal error detail (stack traces,
  // SQL errors, etc.) on 5xx. Intentional 4xx messages (validation, auth) are
  // preserved since routes rely on those being visible to the client.
  fastify.setErrorHandler((err, request, reply) => {
    request.log.error({ err }, 'request error');
    const status = (err as any).statusCode ?? 500;
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
    });
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
