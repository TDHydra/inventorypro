import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import authRoutes from './auth';
import type { DemoModeGate } from '../lib/demoMode';

// Phase E (#138) — /auth/roster piggybacks the org default theme so the
// sign-in screen and fresh installs are themed before any login. A theme id
// is public by design; the field must be null (not absent) when unset.
const SECRET = 'unit-test-secret-that-is-at-least-32-chars!!';
const ROSTER_ROWS = [
  { id: '5f0c1a2b-3d4e-4f60-8a9b-0c1d2e3f4a5b', name: 'Alice', role: 'admin',
    pin_length_required: 4, pin_set: true, is_test: false, test_code: null },
];

function fakePg(orgTheme: string | null) {
  return {
    query: async (sql: string) => {
      if (sql.includes(`key = 'default_theme_id'`)) {
        return { rows: orgTheme ? [{ value: orgTheme }] : [] };
      }
      if (sql.includes('pin_hash IS NOT NULL')) return { rows: ROSTER_ROWS };
      return { rows: [] };
    },
  };
}

const gate: DemoModeGate = { isEnabled: async () => false, invalidate() {} };

async function buildApp(orgTheme: string | null) {
  const app = Fastify();
  app.decorate('pg', fakePg(orgTheme) as never);
  await app.register(fastifyJwt, { secret: SECRET });
  await app.register(authRoutes, { prefix: '/auth', demoGate: gate });
  await app.ready();
  return app;
}

test('roster carries default_theme_id when app_config has one', async () => {
  const app = await buildApp('futuristic');
  const res = await app.inject({ method: 'GET', url: '/auth/roster' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { users: unknown[]; default_theme_id: string | null };
  assert.equal(body.default_theme_id, 'futuristic');
  assert.equal(body.users.length, 1);
  await app.close();
});

test('roster sends default_theme_id: null when the key is unset', async () => {
  const app = await buildApp(null);
  const res = await app.inject({ method: 'GET', url: '/auth/roster' });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as { default_theme_id: string | null }).default_theme_id, null);
  await app.close();
});
