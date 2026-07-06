import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import teamRoutes from './teams';
import userRoutes from './users';
import authRoutes from './auth';

// Schema validation runs in the Fastify lifecycle BEFORE preHandler (auth), so a
// malformed body/params is rejected with 400 without ever touching the DB. These
// tests assert the request schemas added to the previously-unvalidated PATCH
// routes (users PATCH /:id, teams PATCH /:id + member routes) actually reject bad
// input — and that a well-formed request passes validation (falls through past
// 400 into auth/handler, which errors 5xx here since there's no pg/JWT wired).
async function buildApp() {
  const app = Fastify();
  // Passthrough auth decorator so the route plugins register (they build a
  // preHandler array from fastify.authenticate at registration time).
  app.decorate('authenticate', async () => {});
  await app.register(teamRoutes, { prefix: '/teams' });
  await app.register(userRoutes, { prefix: '/users' });
  await app.register(authRoutes, { prefix: '/auth' });
  await app.ready();
  return app;
}

test('PATCH /users/:id rejects a too-short pin (schema)', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'PATCH', url: '/users/u1', payload: { pin: '1' } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('PATCH /users/:id rejects a non-object permission_overrides (schema)', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'PATCH', url: '/users/u1', payload: { permission_overrides: 'nope' } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('PATCH /users/:id accepts a nullable expires_at (schema passes → not 400)', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'PATCH', url: '/users/u1', payload: { expires_at: null } });
  assert.notEqual(res.statusCode, 400); // passes validation; fails later (no DB) with 5xx
  await app.close();
});

test('PATCH /teams/:id rejects an empty name (schema)', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'PATCH', url: '/teams/t1', payload: { name: '' } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('PATCH /teams/:id/members/:uid rejects a non-boolean is_manager (schema)', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'PATCH', url: '/teams/t1/members/u1', payload: { is_manager: 'yes-please' } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /auth/set-pin rejects a non-6-digit enrollment_code (schema)', async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: 'POST', url: '/auth/set-pin',
    payload: { user_id: 'u1', pin: '1234', enrollment_code: '1234' },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /auth/set-pin rejects a non-numeric enrollment_code (schema)', async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: 'POST', url: '/auth/set-pin',
    payload: { user_id: 'u1', pin: '1234', enrollment_code: 'abcdef' },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /auth/set-pin accepts a well-formed 6-digit enrollment_code (schema passes → not 400)', async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: 'POST', url: '/auth/set-pin',
    payload: { user_id: 'u1', pin: '1234', enrollment_code: '123456' },
  });
  assert.notEqual(res.statusCode, 400); // passes validation; fails later (no DB) with 5xx
  await app.close();
});
