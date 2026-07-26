import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import userRoutes from './users';

// #172 — PIN-change audit rows are now server-authoritative. The admin reset
// routes (PATCH /users/:id reset_pin, POST /users/:id/reset-enrollment-code)
// write the 'user_pin_reset' activity_log row themselves, copying the
// auth.ts login/pin_set INSERT pattern exactly — the mobile client no longer
// appendLogs these (removed from users.tsx to avoid double-logging once the
// row syncs back down).

interface FakeUser {
  role: string;
  name: string;
  permission_overrides?: Record<string, boolean> | null;
  pin_hash?: string | null;
  pin_length_required?: number;
  active?: boolean;
  expires_at?: string | null;
  email?: string | null;
}

function fakePg(users: Record<string, FakeUser>) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  return {
    queries,
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      // callerCan: role + permission_overrides + role_overrides
      if (sql.includes('u.role, u.permission_overrides, rs.permission_overrides')) {
        const u = users[String(params[0])];
        return { rows: u ? [{ role: u.role, permission_overrides: u.permission_overrides ?? {}, role_overrides: null }] : [] };
      }
      // reset-enrollment-code's target lookup
      if (sql.includes('SELECT id, name, role, email, pin_hash FROM users')) {
        const u = users[String(params[0])];
        return u
          ? { rows: [{ id: params[0], name: u.name, role: u.role, email: u.email ?? null, pin_hash: u.pin_hash ?? null }] }
          : { rows: [] };
      }
      // callerRole / target role lookup (PATCH handler queries this twice, once
      // per id — dispatch on the param, not the (identical) sql text)
      if (sql.trim().startsWith('SELECT role FROM users WHERE id = $1')) {
        const u = users[String(params[0])];
        return { rows: u ? [{ role: u.role }] : [] };
      }
      // Role-change pin-length-mismatch probe
      if (sql.includes('current_length, rs.min_pin_length')) {
        const u = users[String(params[0])];
        const minPinLength = MIN_PIN_LENGTH_BY_ROLE[String(params[1])] ?? 4;
        return { rows: u ? [{ current_length: u.pin_length_required ?? 4, min_pin_length: minPinLength }] : [] };
      }
      // The final PATCH UPDATE ... RETURNING
      if (sql.includes('UPDATE users SET') && sql.includes('RETURNING id, name, role')) {
        const id = String(params[0]);
        const u = users[id];
        return {
          rows: u
            ? [{
                id, name: u.name, role: u.role,
                pin_length_required: u.pin_length_required ?? 4,
                permission_overrides: u.permission_overrides ?? {},
                active: u.active ?? true, expires_at: u.expires_at ?? null,
              }]
            : [],
        };
      }
      // reset-enrollment-code's UPDATE
      if (sql.includes('UPDATE users SET enrollment_code_hash')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

const MIN_PIN_LENGTH_BY_ROLE: Record<string, number> = {
  hr_manager: 6,
};

async function buildApp(users: Record<string, FakeUser>, callerId: string) {
  const pg = fakePg(users);
  const app = Fastify();
  app.decorate('pg', pg as never);
  app.decorate('authenticate', async (request: { user?: unknown }) => {
    request.user = { sub: callerId };
  });
  await app.register(userRoutes, { prefix: '/users' });
  await app.ready();
  return { app, pg };
}

const wrote = (pg: { queries: Array<{ sql: string }> }, fragment: string) =>
  pg.queries.some(q => q.sql.includes(fragment));

// ---------------------------------------------------------------------------
// PATCH /users/:id  { reset_pin: true }
// ---------------------------------------------------------------------------

test('PATCH reset_pin: admin resets a crew PIN → 200 + activity_log(user_pin_reset, entity_id=target, user_id=caller, note=target name)', async () => {
  const users: Record<string, FakeUser> = {
    'admin-1': { role: 'full_admin', name: 'Admin' },
    'crew-1': { role: 'carpet_cleaning_crew', name: 'Crew Member' },
  };
  const { app, pg } = await buildApp(users, 'admin-1');
  const res = await app.inject({
    method: 'PATCH', url: '/users/crew-1', payload: { reset_pin: true },
  });
  assert.equal(res.statusCode, 200);
  const log = pg.queries.find(q => q.sql.includes('INSERT INTO activity_log'));
  assert.ok(log, 'activity_log INSERT ran');
  assert.match(log!.sql, /'user_pin_reset'/);
  assert.match(log!.sql, /'user'/);
  assert.deepEqual(log!.params.slice(0, 3), ['admin-1', 'crew-1', 'Crew Member']);
  const metadata = JSON.parse(String(log!.params[3]));
  assert.ok(metadata.request_id, 'metadata carries request_id');
  await app.close();
});

test('PATCH reset_pin: forbidden caller (not at/above target tier) → 403, no activity_log row', async () => {
  const users: Record<string, FakeUser> = {
    'crew-1': { role: 'carpet_cleaning_crew', name: 'Crew Member' },
    'admin-1': { role: 'full_admin', name: 'Admin' },
  };
  const { app, pg } = await buildApp(users, 'crew-1');
  const res = await app.inject({
    method: 'PATCH', url: '/users/admin-1', payload: { reset_pin: true },
  });
  assert.equal(res.statusCode, 403);
  assert.ok(!wrote(pg, 'INSERT INTO activity_log'), 'no audit row on a rejected attempt');
  await app.close();
});

test('PATCH role change with implicit pin-length mismatch (no explicit reset_pin) → no user_pin_reset audit row', async () => {
  // office_manager (tier 3, min_pin_length 4) → hr_manager (tier 3, min_pin_length 6):
  // pinLengthMismatch fires and the PIN is cleared, but this is NOT an explicit
  // admin-initiated reset — the client's own 'user_role_changed' log already
  // covers it, so the server must not double-log it as 'user_pin_reset'.
  const users: Record<string, FakeUser> = {
    'admin-1': { role: 'full_admin', name: 'Admin' },
    'om-1': { role: 'office_manager', name: 'Office Manager', pin_length_required: 4 },
  };
  const { app, pg } = await buildApp(users, 'admin-1');
  const res = await app.inject({
    method: 'PATCH', url: '/users/om-1', payload: { role: 'hr_manager' },
  });
  assert.equal(res.statusCode, 200);
  assert.ok(!wrote(pg, 'INSERT INTO activity_log'), 'role-change-triggered reset is not separately audited here');
  await app.close();
});

// ---------------------------------------------------------------------------
// POST /users/:id/reset-enrollment-code
// ---------------------------------------------------------------------------

test('reset-enrollment-code: not-yet-onboarded target → 200 + activity_log(user_pin_reset, entity_id=target, user_id=caller, note=target name)', async () => {
  const users: Record<string, FakeUser> = {
    'admin-1': { role: 'full_admin', name: 'Admin' },
    'new-1': { role: 'carpet_cleaning_crew', name: 'New Hire', pin_hash: null, email: null },
  };
  const { app, pg } = await buildApp(users, 'admin-1');
  const res = await app.inject({
    method: 'POST', url: '/users/new-1/reset-enrollment-code', payload: {},
  });
  assert.equal(res.statusCode, 200);
  const log = pg.queries.find(q => q.sql.includes('INSERT INTO activity_log'));
  assert.ok(log, 'activity_log INSERT ran');
  assert.match(log!.sql, /'user_pin_reset'/);
  assert.deepEqual(log!.params.slice(0, 3), ['admin-1', 'new-1', 'New Hire']);
  await app.close();
});

test('reset-enrollment-code: target already has a PIN → 409, no activity_log row', async () => {
  const users: Record<string, FakeUser> = {
    'admin-1': { role: 'full_admin', name: 'Admin' },
    'has-pin-1': { role: 'carpet_cleaning_crew', name: 'Has Pin', pin_hash: 'somehash', email: null },
  };
  const { app, pg } = await buildApp(users, 'admin-1');
  const res = await app.inject({
    method: 'POST', url: '/users/has-pin-1/reset-enrollment-code', payload: {},
  });
  assert.equal(res.statusCode, 409);
  assert.ok(!wrote(pg, 'INSERT INTO activity_log'), 'no audit row when the request is rejected');
  await app.close();
});
