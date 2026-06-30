import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyPostgres from '@fastify/postgres';
import fastifyCors from '@fastify/cors';
import { runMigrations } from './db/migrate';
import { overRateLimit } from './lib/rateLimit';

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

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
});

async function build() {
  // CORS — allowlist instead of reflecting any Origin. Native apps send no Origin
  // (fetch omits it) → allowed; browser origins must match the configured web
  // host(s) or localhost (dev). Override/extend via CORS_ORIGINS (comma-separated).
  const allowedOrigins = (process.env.CORS_ORIGINS ?? 'https://frontend.plexcontrol.com')
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

  // Health check
  fastify.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

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
    });
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
