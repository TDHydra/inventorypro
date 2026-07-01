import { FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcrypt';
import { randomInt } from 'node:crypto';
import { requirePermission, userHasPermission } from '../lib/permissions';

// Resolve the caller's effective permissions (role default + role/user overrides),
// same source requirePermission uses. Returns null when the caller is unknown.
async function callerCan(fastify: any, userId: string) {
  const { rows } = await fastify.pg.query(
    `SELECT u.role, u.permission_overrides, rs.permission_overrides AS role_overrides
       FROM users u LEFT JOIN role_settings rs ON rs.role = u.role
      WHERE u.id = $1`, [userId]);
  const u = rows[0];
  if (!u) return null;
  return (perm: string) => userHasPermission(u.role, u.permission_overrides, perm, u.role_overrides);
}

// Roles that confer broad authority — creating or assigning these (or any explicit
// permission overrides) is itself a privilege grant, so it requires the
// roles-&-permissions permission, not merely manage_users.
const PRIVILEGED_ROLES = new Set(['full_admin', 'franchise_manager']);

// One-time enrollment code — required by /auth/set-pin before an unauthenticated
// first-login caller can set a user's PIN. Bcrypt-hashed at rest; the plaintext
// is returned ONCE to the caller and never stored or synced. Shared by user
// creation and by admin-triggered PIN resets (a reset otherwise leaves the
// account dead-ended: no PIN, and no enrollment code to set a new one).
async function issueEnrollmentCode(): Promise<{ code: string; hash: string }> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const hash = await bcrypt.hash(code, 10);
  return { code, hash };
}

interface CreateUserBody {
  name: string;
  role: string;
  pin?: string; // optional — if omitted the user sets it on first login
  expires_at?: string;
  permission_overrides?: Record<string, boolean>;
}

interface UpdateUserBody {
  name?: string;
  role?: string;
  pin?: string;
  reset_pin?: boolean; // clear PIN → user re-sets it on next sign-in
  active?: boolean;
  expires_at?: string | null;
  permission_overrides?: Record<string, boolean>;
}

const routes: FastifyPluginAsync = async (fastify) => {
  const auth = { preHandler: [(fastify as any).authenticate] };

  // GET /users
  fastify.get('/', auth, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const can = await callerCan(fastify, userId);
    if (!can || !can('manage_users')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const { rows } = await fastify.pg.query(
      `SELECT id, name, role, pin_length_required, permission_overrides, active, expires_at, created_at, updated_at
       FROM users ORDER BY name ASC`
    );
    return { users: rows };
  });

  // POST /users — create user. PIN is optional: when omitted, the user sets and
  // confirms their own PIN on first login (pin_set stays false).
  fastify.post<{ Body: CreateUserBody }>('/', {
    preHandler: [(fastify as any).authenticate, requirePermission('manage_users')],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'role'],
        properties: {
          name: { type: 'string' },
          role: { type: 'string' },
          pin: { type: 'string', minLength: 4, maxLength: 8 },
          expires_at: { type: 'string' },
          permission_overrides: { type: 'object' },
        },
      },
    },
  }, async (request, reply) => {
    const { name, role, pin, expires_at, permission_overrides = {} } = request.body;

    // Creating a privileged role or any explicit permission override is itself a
    // privilege grant → require manage_roles_permissions, not just manage_users.
    if (PRIVILEGED_ROLES.has(role) || Object.keys(permission_overrides).length > 0) {
      const can = await callerCan(fastify, (request.user as { sub: string }).sub);
      if (!can || !can('manage_roles_permissions')) {
        return reply.status(403).send({ error: 'Creating an admin role or custom permissions requires the roles & permissions permission.' });
      }
    }
    // Default PIN length expectation from role tier could be added later; for now
    // store the provided length, or 4 as a placeholder until the user sets it.
    const pinHash = pin ? await bcrypt.hash(pin, 10) : null;
    const pinLength = pin ? pin.length : 4;
    const pinSet = !!pin;

    const { code: enrollmentCode, hash: enrollmentCodeHash } = await issueEnrollmentCode();

    const { rows } = await fastify.pg.query(
      `INSERT INTO users (name, role, pin_hash, pin_length_required, pin_set, permission_overrides, expires_at, enrollment_code_hash)
       VALUES ($1, $2::user_role, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING id, name, role, pin_length_required, pin_set, active, created_at`,
      [name, role, pinHash, pinLength, pinSet, JSON.stringify(permission_overrides), expires_at ?? null, enrollmentCodeHash]
    );
    return reply.status(201).send({ ...rows[0], enrollment_code: enrollmentCode });
  });

  // PATCH /users/:id — update user
  fastify.patch<{ Params: { id: string }; Body: UpdateUserBody }>('/:id', auth, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const targetId = request.params.id;
    const can = await callerCan(fastify, userId);
    if (!can || !can('manage_users')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const { name, role, pin, reset_pin, active, expires_at, permission_overrides } = request.body;

    // Changing role or permission_overrides is a privilege operation: it requires
    // manage_roles_permissions (tier-4), and you may NOT change your OWN role/perms
    // (blocks self-escalation — the old self-edit path let any user grant
    // themselves full_admin). Assigning a privileged role needs the same gate.
    const changingPrivilege =
      role !== undefined || permission_overrides !== undefined;
    if (changingPrivilege) {
      if (!can('manage_roles_permissions')) {
        return reply.status(403).send({ error: 'Changing role or permissions requires the roles & permissions permission.' });
      }
      if (targetId === userId) {
        return reply.status(403).send({ error: 'You cannot change your own role or permissions.' });
      }
    }
    const updates: string[] = [];
    const values: unknown[] = [request.params.id];
    let i = 2;

    if (name !== undefined) { updates.push(`name = $${i++}`); values.push(name); }
    if (role !== undefined) { updates.push(`role = $${i++}::user_role`); values.push(role); }
    if (active !== undefined) { updates.push(`active = $${i++}`); values.push(active); }
    if (expires_at !== undefined) { updates.push(`expires_at = $${i++}`); values.push(expires_at); }
    if (permission_overrides !== undefined) { updates.push(`permission_overrides = $${i++}::jsonb`); values.push(JSON.stringify(permission_overrides)); }
    let newEnrollmentCode: string | undefined;
    if (reset_pin) {
      // Architecture: no admin-chosen PINs. Reset clears the hash so the user
      // sets and confirms a fresh PIN themselves on next sign-in (pin_set=false).
      // It also must reissue an enrollment code — pin_hash/pin_set alone leave
      // the account dead-ended, since /auth/set-pin requires a code and the
      // original one-time code was already consumed (nulled) at first onboarding.
      const issued = await issueEnrollmentCode();
      newEnrollmentCode = issued.code;
      updates.push(`pin_hash = NULL`, `pin_set = FALSE`, `enrollment_code_hash = $${i++}`);
      values.push(issued.hash);
    } else if (pin !== undefined) {
      const hash = await bcrypt.hash(pin, 10);
      updates.push(`pin_hash = $${i++}`, `pin_length_required = $${i++}`, `pin_set = TRUE`);
      values.push(hash, pin.length);
    }

    if (updates.length === 0) return reply.status(400).send({ error: 'No valid fields' });

    const { rows } = await fastify.pg.query(
      `UPDATE users SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $1
       RETURNING id, name, role, pin_length_required, permission_overrides, active, expires_at`,
      values
    );
    if (!rows[0]) return reply.status(404).send({ error: 'User not found' });
    return newEnrollmentCode ? { ...rows[0], enrollment_code: newEnrollmentCode } : rows[0];
  });
};

export default routes;
