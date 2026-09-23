import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import authRoutes from './auth';

// Refresh-token rotation (v2): /auth/refresh returns a rotated refresh token
// carrying the ORIGINAL login time (auth_time) and enforces a 30-day absolute
// session cap. Minimal-app style like auth-schema.test.ts, plus a pg stub
// that serves the /refresh handler's users SELECT.
const SECRET = 'unit-test-secret-that-is-at-least-32-chars!!';
const USER_ID = '5f0c1a2b-3d4e-4f60-8a9b-0c1d2e3f4a5b';

function userRow(overrides: Record<string, unknown> = {}) {
  return { id: USER_ID, name: 'Dev Tester', role: 'construction_crew', active: true, expires_at: null, is_test: false, ...overrides };
}

async function buildApp(row: Record<string, unknown> | null = userRow()) {
  const app = Fastify();
  await app.register(fastifyJwt, { secret: SECRET });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.decorate('pg', {
    query: async (sql: string) => {
      if (sql.includes('FROM users')) return { rows: row ? [row] : [] };
      return { rows: [] };
    },
  } as any);
  await app.register(authRoutes, { prefix: '/auth' });
  await app.ready();
  return app;
}

type RefreshClaims = { sub: string; type: string; auth_time?: number; iat: number; exp: number };

test('refresh rotates: returns a new refresh token preserving the original auth_time', async () => {
  const app = await buildApp();
  const authTime = Math.floor(Date.now() / 1000) - 24 * 3600; // logged in a day ago
  const refresh = app.jwt.sign({ sub: USER_ID, type: 'refresh', auth_time: authTime }, { expiresIn: '7d' });
  const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refresh_token: refresh } });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { jwt: string; refreshToken: string };
  assert.ok(body.jwt, 'must return a fresh access JWT');
  assert.ok(body.refreshToken, 'must return a rotated refresh token');
  const claims = app.jwt.verify<RefreshClaims>(body.refreshToken);
  assert.equal(claims.type, 'refresh');
  assert.equal(claims.auth_time, authTime, 'auth_time must be preserved verbatim across rotations');
  assert.ok(claims.exp - claims.iat > 6 * 24 * 3600, 'rotated token must carry the full 7d window');
  await app.close();
});

test('a pre-rotation token (no auth_time) still refreshes; its iat becomes the origin', async () => {
  const app = await buildApp();
  const refresh = app.jwt.sign({ sub: USER_ID, type: 'refresh' }, { expiresIn: '7d' });
  const iat = app.jwt.decode<RefreshClaims>(refresh)!.iat;
  const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refresh_token: refresh } });
  assert.equal(res.statusCode, 200);
  const claims = app.jwt.verify<RefreshClaims>((res.json() as { refreshToken: string }).refreshToken);
  assert.equal(claims.auth_time, iat, 'legacy token origin must be its own iat');
  await app.close();
});

test('the 30-day absolute cap: an auth_time older than 30d is a definitive 401', async () => {
  const app = await buildApp();
  const staleOrigin = Math.floor(Date.now() / 1000) - 31 * 24 * 3600;
  const refresh = app.jwt.sign({ sub: USER_ID, type: 'refresh', auth_time: staleOrigin }, { expiresIn: '7d' });
  const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refresh_token: refresh } });
  // 401 (not 403): the mobile client maps 401/403 to session-dead → re-login,
  // and the token itself is otherwise valid — the SESSION aged out.
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('a test account rotates onto the SHORT window (<=1h), mirroring its login mint', async () => {
  const app = await buildApp(userRow({ is_test: true }));
  const authTime = Math.floor(Date.now() / 1000);
  const refresh = app.jwt.sign({ sub: USER_ID, type: 'refresh', auth_time: authTime }, { expiresIn: '1h' });
  const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refresh_token: refresh } });
  assert.equal(res.statusCode, 200);
  const claims = app.jwt.verify<RefreshClaims>((res.json() as { refreshToken: string }).refreshToken);
  assert.ok(claims.exp - claims.iat <= 3600, 'test-account rotation must not widen the 1h window');
  await app.close();
});

test('an access token presented as a refresh token stays a 401 (type gate unchanged)', async () => {
  const app = await buildApp();
  const access = app.jwt.sign({ sub: USER_ID, name: 'Dev Tester', role: 'construction_crew' }, { expiresIn: '15m' });
  const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refresh_token: access } });
  assert.equal(res.statusCode, 401);
  await app.close();
});
