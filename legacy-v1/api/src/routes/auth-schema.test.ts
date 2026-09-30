import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import bcrypt from 'bcrypt';
import authRoutes, { isRefreshToken } from './auth';

// Covers the batch-2 auth hardening:
//  - /auth/token & /auth/set-pin user_id is schema-bound to a UUID shape
//    (maxLength + pattern), so unauthenticated junk user_ids are rejected with
//    400 BEFORE they can create brute-force-map entries (memory-DoS guard).
//  - the authenticate decorator rejects refresh tokens ({type:'refresh'})
//    presented as Bearer access tokens, while legacy access tokens (no type
//    claim) keep working.
// Same minimal-app style as schema-validation.test.ts, but with real JWT
// registered so we can sign tokens; the authenticate decorator mirrors
// index.ts (jwtVerify + the shared isRefreshToken guard).
const SECRET = 'unit-test-secret-that-is-at-least-32-chars!!';
const VALID_UUID = '5f0c1a2b-3d4e-4f60-8a9b-0c1d2e3f4a5b';

async function buildApp() {
  const app = Fastify();
  app.decorate('authenticate', async function (request: any, reply: any) {
    try {
      const payload = await request.jwtVerify();
      if (isRefreshToken(payload)) throw new Error('refresh token is not an access token');
    } catch {
      reply.status(401).send({ error: 'Unauthorized' });
    }
  });
  await app.register(fastifyJwt, { secret: SECRET });
  await app.register(authRoutes, { prefix: '/auth' });
  // Stand-in protected route using the decorator, like every real route does.
  app.get('/protected', { preHandler: [(app as any).authenticate] }, async () => ({ ok: true }));
  await app.ready();
  return app;
}

test('POST /auth/token rejects an oversized user_id (schema 400)', async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: 'POST', url: '/auth/token',
    payload: { user_id: 'a'.repeat(4096), pin: '1234' },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /auth/token rejects a non-UUID user_id (schema 400)', async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: 'POST', url: '/auth/token',
    payload: { user_id: 'not-a-uuid-but-36-characters-long!!!', pin: '1234' },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /auth/token accepts a well-formed UUID user_id (schema passes → not 400)', async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: 'POST', url: '/auth/token',
    payload: { user_id: VALID_UUID, pin: '1234' },
  });
  assert.notEqual(res.statusCode, 400); // passes validation; fails later (no DB) with 5xx
  await app.close();
});

test('POST /auth/set-pin rejects a non-UUID user_id (schema 400)', async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: 'POST', url: '/auth/set-pin',
    payload: { user_id: 'u1', pin: '1234', enrollment_code: '123456' },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

// --- /auth/set-pin weak-PIN rejection (#90) ------------------------------
// The schema (minLength/maxLength) accepts a weak PIN; rejection happens in the
// handler. Drive the handler with a stubbed pg so we reach the isWeakPin check
// on a valid, not-yet-enrolled user with a live enrollment code.
async function buildSetPinApp(overrides: Record<string, unknown> = {}) {
  const app = Fastify();
  const codeHash = await bcrypt.hash('123456', 10);
  const userRow = {
    id: VALID_UUID, name: 'New User', role: 'staff',
    pin_set: false, active: true, expires_at: null,
    enrollment_code_hash: codeHash,
    enrollment_code_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    is_test: false, enrollment_code_public: null, min_pin_length: 4,
    ...overrides,
  };
  app.decorate('pg', {
    query: async (sql: string) => {
      if (/from users/i.test(sql)) return { rows: [userRow] };
      return { rows: [] }; // UPDATE users / INSERT activity_log
    },
  } as any);
  await app.register(fastifyJwt, { secret: SECRET });
  await app.register(authRoutes, { prefix: '/auth' });
  await app.ready();
  return app;
}

test('POST /auth/set-pin rejects a weak PIN (1234) with 400', async () => {
  const app = await buildSetPinApp();
  const res = await app.inject({
    method: 'POST', url: '/auth/set-pin',
    payload: { user_id: VALID_UUID, pin: '1234', enrollment_code: '123456' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /too easy to guess/i);
  await app.close();
});

test('POST /auth/set-pin rejects a repeated-digit PIN (0000) with 400', async () => {
  const app = await buildSetPinApp();
  const res = await app.inject({
    method: 'POST', url: '/auth/set-pin',
    payload: { user_id: VALID_UUID, pin: '0000', enrollment_code: '123456' },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /auth/set-pin accepts a strong PIN (not 400)', async () => {
  const app = await buildSetPinApp();
  const res = await app.inject({
    method: 'POST', url: '/auth/set-pin',
    payload: { user_id: VALID_UUID, pin: '1957', enrollment_code: '123456' },
  });
  assert.notEqual(res.statusCode, 400); // passes weak-PIN + all checks → session issued
  await app.close();
});

test('a refresh token presented as Bearer on a protected route → 401', async () => {
  const app = await buildApp();
  const refresh = app.jwt.sign({ sub: VALID_UUID, type: 'refresh' }, { expiresIn: '7d' });
  const res = await app.inject({
    method: 'GET', url: '/protected',
    headers: { authorization: `Bearer ${refresh}` },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('a legacy access token (no type claim) passes authenticate', async () => {
  const app = await buildApp();
  const access = app.jwt.sign({ sub: VALID_UUID, name: 'Test User', role: 'admin' }, { expiresIn: '15m' });
  const res = await app.inject({
    method: 'GET', url: '/protected',
    headers: { authorization: `Bearer ${access}` },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
  await app.close();
});

test('a garbage Bearer token still → 401', async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: 'GET', url: '/protected',
    headers: { authorization: 'Bearer not.a.jwt' },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});
