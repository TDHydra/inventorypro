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
  // Stub pg so sync's registration-time column introspection resolves (empty
  // rows are fine — schema validation runs before any handler touches pg).
  app.decorate('pg', { query: async () => ({ rows: [] }) });
  await app.register(teamRoutes, { prefix: '/teams' });
  await app.register(userRoutes, { prefix: '/users' });
  await app.register(authRoutes, { prefix: '/auth' });
  // sync's import chain pulls in lib/s3.ts, which fails closed at import time
  // without MinIO credentials — set dummies before a DYNAMIC import (a static
  // import would hoist above the env assignment; same pattern as mediaCleanup.test).
  process.env.MINIO_ACCESS_KEY ??= 'test-access';
  process.env.MINIO_SECRET_KEY ??= 'test-secret';
  const syncRoutes = (await import('./sync')).default;
  await app.register(syncRoutes, { prefix: '/sync' });
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
    payload: { user_id: '3f0e8a52-9c4d-4b6e-8f1a-2d7c5e9b0a41', pin: '1234', enrollment_code: '1234' },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /auth/set-pin rejects a non-numeric enrollment_code (schema)', async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: 'POST', url: '/auth/set-pin',
    payload: { user_id: '3f0e8a52-9c4d-4b6e-8f1a-2d7c5e9b0a41', pin: '1234', enrollment_code: 'abcdef' },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /auth/set-pin accepts a well-formed 6-digit enrollment_code (schema passes → not 400)', async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: 'POST', url: '/auth/set-pin',
    payload: { user_id: '3f0e8a52-9c4d-4b6e-8f1a-2d7c5e9b0a41', pin: '1234', enrollment_code: '123456' },
  });
  assert.notEqual(res.statusCode, 400); // passes validation; fails later (no DB) with 5xx
  await app.close();
});

const pushEntry = (i: number) => ({ id: `e${i}`, table_name: 'items', op: 'update', payload: {} });

test('POST /sync/push rejects a batch of 101 entries (schema maxItems)', async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: { entries: Array.from({ length: 101 }, (_, i) => pushEntry(i)) },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /sync/push accepts a batch of 50 entries (schema passes → not 400)', async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: { entries: Array.from({ length: 50 }, (_, i) => pushEntry(i)) },
  });
  // Mobile client pushes up to 50 per batch (engine.ts getPendingOutbox(50)) and
  // does not split on 4xx — this must never be schema-rejected.
  assert.notEqual(res.statusCode, 400); // reaches the handler; fails there (stub auth/pg)
  await app.close();
});
