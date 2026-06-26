import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyPostgres from '@fastify/postgres';
import fastifyCors from '@fastify/cors';
import { runMigrations } from './db/migrate';

import authRoutes from './routes/auth';
import syncRoutes from './routes/sync';
import itemRoutes from './routes/items';
import locationRoutes from './routes/locations';
import jobRoutes from './routes/jobs';
import teamRoutes from './routes/teams';
import userRoutes from './routes/users';
import logRoutes from './routes/logs';
import mediaRoutes from './routes/media';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
});

async function build() {
  // CORS — allow Expo dev client and production app
  await fastify.register(fastifyCors, {
    origin: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });

  // Postgres
  await fastify.register(fastifyPostgres, {
    connectionString: process.env.DATABASE_URL,
  });

  // JWT
  await fastify.register(fastifyJwt, {
    secret: process.env.JWT_SECRET!,
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
