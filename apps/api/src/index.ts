import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyError } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyPostgres from '@fastify/postgres';
import fastifyCors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { runMigrations } from './db/migrate';
import { overRateLimit, overLimit, peekOverLimit, sweepBuckets } from './lib/rateLimit';
import { startNotificationTimer } from './lib/notificationTimer';
import { recordAudit, startAuditPruneTimer } from './lib/auditWriter';
import { startErrorCanaryTimer } from './lib/errorCanary';
import { createTestAccountGate } from './lib/testAccounts';
import { createDemoModeGate } from './lib/demoMode';
import { sanitizeErrorMessage } from './lib/audit';

import authRoutes, { isRefreshToken, sweepAttempts } from './routes/auth';
import syncRoutes from './routes/sync';
import itemRoutes from './routes/items';
import locationRoutes from './routes/locations';
import jobRoutes from './routes/jobs';
import teamRoutes from './routes/teams';
import userRoutes from './routes/users';
import meRoutes from './routes/me';
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
    // #238: defense-in-depth, not an active leak — Fastify's default req
    // serializer never includes headers, and nothing in this codebase logs
    // request.headers today (lib/audit.ts documents the same invariant). This
    // guard exists so that if a future change ever logs a req with headers
    // attached, the live JWT in Authorization gets censored instead of landing
    // verbatim in the log.
    redact: {
      paths: ['req.headers.authorization'],
      censor: '[redacted]',
    },
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
  // TRUST_PROXY is a comma-separated list of IPs/CIDRs, split here because
  // proxy-addr wants an array, not a comma string. It must include EVERY hop
  // address NPM can arrive from: NPM runs in HOST network mode on unraid, so
  // its requests reach this container from the host's LAN IP (192.168.1.239),
  // NOT from inside the docker bridge subnet — trusting only 172.18.0.0/16
  // silently ignored X-Forwarded-For and audited every request as the proxy.
  // The loopback default keeps local dev booting.
  trustProxy: process.env.TRUST_PROXY
    ? process.env.TRUST_PROXY.split(',').map(s => s.trim())
    : '127.0.0.1',
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
    // #238: explicit cap, not pg's default (unbounded per-Pool, effectively
    // 10 in practice but undocumented as a guarantee). Prerequisite for
    // running two api containers side-by-side (rolling deploy / blue-green):
    // Postgres itself defaults to max_connections=100, and each container
    // gets its own pool — two uncapped pools plus the dedicated migration
    // client (db/migrate.ts) can exhaust that well before other consumers
    // (psql, the restore-test timer) get a slot. 10 per container leaves
    // headroom for a second container at this size.
    max: 10,
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

  // Auth decorator — verifies JWT on protected routes. Refresh tokens are
  // signed with the same secret, so a bare jwtVerify would accept a 7-day
  // refresh token anywhere a 15-minute access token is expected — reject
  // type:'refresh' explicitly. Legacy access tokens (no type claim) still pass.
  fastify.decorate('authenticate', async function (request: any, reply: any) {
    try {
      const payload = await request.jwtVerify();
      if (isRefreshToken(payload)) throw new Error('refresh token is not an access token');
    } catch {
      reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  // Surface the correlation id to the caller on every response, including errors.
  fastify.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
  });

  // Generous global per-IP ceiling for UNAUTHENTICATED traffic (300/min). A
  // caller with a valid JWT is skipped — authenticated users have their own
  // per-user buckets, and one office NAT must never rate-limit a whole crew
  // because of shared-IP volume. This only throttles anonymous scanners/
  // scrapers hammering the public surface (/health, /auth/roster, 404 probes).
  fastify.addHook('onRequest', async (request: any, reply: any) => {
    try {
      await request.jwtVerify();
      return; // valid JWT (access or refresh) → not anonymous traffic
    } catch { /* unauthenticated — fall through to the IP bucket */ }
    if (overLimit(`anon:${request.ip}`, 300)) {
      return reply.status(429).send({ error: 'Too many requests. Please slow down and try again.' });
    }
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
  // DB-resolved is_test lookups for the write wall below (60s TTL cache).
  const testGate = createTestAccountGate({
    query: (sql, params) => fastify.pg.query(sql, params as any[]),
  });

  // Demo-mode kill switch (app_config.demo_mode, migration 047). ONE shared
  // instance: PATCH /audit/demo-mode invalidates the same cache the /auth
  // roster/set-pin checks read.
  const demoGate = createDemoModeGate({
    query: (sql, params) => fastify.pg.query(sql, params as any[]),
  });

  fastify.addHook('preHandler', async (request: any, reply: any) => {
    // An IP that keeps sending schema-invalid requests (see the vreject bucket
    // fed by setErrorHandler below) is probing, not typo-ing — cut it off
    // early. peek only: this hook must not consume quota the error handler owns.
    if (peekOverLimit(`vreject:${request.ip}`, 30)) {
      return reply.status(429).send({ error: 'Too many requests. Please slow down and try again.' });
    }
    const m = request.method;
    // Every mutating verb. No route uses PUT today (CORS excludes it too), but
    // it's covered so a future PUT route can't silently bypass the test-account
    // write wall or the per-user mut: bucket below.
    if (m !== 'POST' && m !== 'PATCH' && m !== 'PUT' && m !== 'DELETE') return;
    if (request.url.startsWith('/auth')) return;
    let payload: any;
    try { payload = await request.jwtVerify(); } catch { return; }
    // A refresh token must never act as an access token (same-secret JWTs);
    // reject here too — this hook runs before the route's authenticate.
    if (isRefreshToken(payload)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const sub: string | undefined = payload?.sub;
    // Test/demo accounts are read-only server-wide — every mutating route,
    // /telemetry included. Their sessions are sandboxed on-device; nothing they
    // do may leave a trace here. (DB-resolved, never the JWT claim.)
    if (sub && (await testGate.isTestUser(sub))) {
      return reply.status(403).send({ error: 'Forbidden: test accounts are read-only on the server' });
    }
    // /telemetry has its OWN per-user/IP `telemetry:` bucket (routes/telemetry.ts)
    // and is fire-and-forget behavioral ingest — never let a telemetry flush burst
    // consume a user's business `mut:` (/sync/push) quota.
    if (request.url.startsWith('/telemetry')) return;
    if (sub && overRateLimit(`mut:${sub}`)) {
      return reply.status(429).send({ error: 'Too many requests. Please slow down and try again.' });
    }
  });

  // Routes
  await fastify.register(authRoutes, { prefix: '/auth', demoGate });
  await fastify.register(syncRoutes, { prefix: '/sync' });
  await fastify.register(itemRoutes, { prefix: '/items' });
  await fastify.register(locationRoutes, { prefix: '/locations' });
  await fastify.register(jobRoutes, { prefix: '/jobs' });
  await fastify.register(teamRoutes, { prefix: '/teams' });
  await fastify.register(userRoutes, { prefix: '/users' });
  await fastify.register(meRoutes, { prefix: '/me' });
  await fastify.register(logRoutes, { prefix: '/logs' });
  await fastify.register(mediaRoutes, { prefix: '/media' });
  await fastify.register(labelRoutes, { prefix: '/labels' });
  await fastify.register(telemetryRoutes, { prefix: '/telemetry' });
  await fastify.register(pushRoutes, { prefix: '/push' });
  await fastify.register(notificationsRoutes, { prefix: '/notifications' });
  await fastify.register(auditRoutes, { prefix: '/audit', demoGate });

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
  fastify.setErrorHandler((err: FastifyError, request, reply) => {
    request.log.error({ err }, 'request error');
    const status = (err as any).statusCode ?? 500;
    // Schema-validation rejects are flagged for the audit trail (outcome
    // 'validation_reject' — a boolean, never the offending body) and counted
    // per-IP: a burst of malformed requests is fuzzing, and the preHandler
    // peek 429s the IP once this bucket is over.
    if ((err as any).validation) {
      (request as any).auditValidationReject = true;
      overLimit(`vreject:${request.ip}`, 30);
    }
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

// Sweep the in-memory brute-force (auth attempts) and rate-limit (buckets) maps
// periodically. Neither map otherwise deletes stale keys, so unauthenticated
// junk (bogus user_ids on /auth/token, one-off roster IPs) and churned user
// buckets grow them without bound — a slow memory-exhaustion DoS. Same
// run-now-then-interval + unref pattern as startAuditPruneTimer.
function startLimiterSweepTimer(): NodeJS.Timeout {
  const run = () => {
    const now = Date.now();
    sweepAttempts(now);
    sweepBuckets(now);
  };
  run();
  const t = setInterval(run, 10 * 60_000);
  t.unref();
  return t;
}

// #238: drain in-flight requests instead of dropping them on deploy/restart.
// `docker compose stop` (and `docker stop`) sends SIGTERM and then waits —
// SIGKILL only after its default 10s grace period — so app.close() (which
// runs fastify's onClose hooks and waits for in-flight requests/pg pool
// clients to finish) has a real window to complete cleanly before that
// SIGKILL would otherwise cut a mid-flight /sync/push transaction. The 10s
// process.exit fallback here matches docker's own default grace period, so
// on a slow drain we exit on our own terms (a clean log line, exit code 1)
// right as docker's SIGKILL would otherwise land anyway, rather than racing it.
function setupGracefulShutdown(app: Awaited<ReturnType<typeof build>>): void {
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return; // a second signal during drain — ignore, let the timer win
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    const hardExit = setTimeout(() => {
      app.log.error('graceful shutdown timed out after 10s, forcing exit');
      process.exit(1);
    }, 10_000);
    hardExit.unref();
    app.close(() => {
      clearTimeout(hardExit);
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

runMigrations()
  .then(() => build())
  .then(app => {
    setupGracefulShutdown(app);
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
      // #210: notify admins when server_error audit rows spike.
      startErrorCanaryTimer(app.pg);
      // GC the in-memory limiter maps so they can't grow without bound.
      startLimiterSweepTimer();
    });
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
