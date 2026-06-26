import { FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcrypt';

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

const ADMIN_ROLES = new Set(['full_admin', 'hr_manager', 'office_manager', 'franchise_manager']);

const routes: FastifyPluginAsync = async (fastify) => {
  const auth = { preHandler: [(fastify as any).authenticate] };

  // GET /users
  fastify.get('/', auth, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { rows: [caller] } = await fastify.pg.query(
      `SELECT role FROM users WHERE id = $1`, [userId]
    );

    if (!ADMIN_ROLES.has((caller as { role: string }).role)) {
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
    ...auth,
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
    // Default PIN length expectation from role tier could be added later; for now
    // store the provided length, or 4 as a placeholder until the user sets it.
    const pinHash = pin ? await bcrypt.hash(pin, 10) : null;
    const pinLength = pin ? pin.length : 4;
    const pinSet = !!pin;

    const { rows } = await fastify.pg.query(
      `INSERT INTO users (name, role, pin_hash, pin_length_required, pin_set, permission_overrides, expires_at)
       VALUES ($1, $2::user_role, $3, $4, $5, $6::jsonb, $7)
       RETURNING id, name, role, pin_length_required, pin_set, active, created_at`,
      [name, role, pinHash, pinLength, pinSet, JSON.stringify(permission_overrides), expires_at ?? null]
    );
    return reply.status(201).send(rows[0]);
  });

  // PATCH /users/:id — update user
  fastify.patch<{ Params: { id: string }; Body: UpdateUserBody }>('/:id', auth, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { rows: [caller] } = await fastify.pg.query(
      `SELECT role FROM users WHERE id = $1`, [userId]
    );

    if (!ADMIN_ROLES.has((caller as { role: string }).role) && userId !== request.params.id) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const { name, role, pin, reset_pin, active, expires_at, permission_overrides } = request.body;
    const updates: string[] = [];
    const values: unknown[] = [request.params.id];
    let i = 2;

    if (name !== undefined) { updates.push(`name = $${i++}`); values.push(name); }
    if (role !== undefined) { updates.push(`role = $${i++}::user_role`); values.push(role); }
    if (active !== undefined) { updates.push(`active = $${i++}`); values.push(active); }
    if (expires_at !== undefined) { updates.push(`expires_at = $${i++}`); values.push(expires_at); }
    if (permission_overrides !== undefined) { updates.push(`permission_overrides = $${i++}::jsonb`); values.push(JSON.stringify(permission_overrides)); }
    if (reset_pin) {
      // Architecture: no admin-chosen PINs. Reset clears the hash so the user
      // sets and confirms a fresh PIN themselves on next sign-in (pin_set=false).
      updates.push(`pin_hash = NULL`, `pin_set = FALSE`);
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
    return rows[0];
  });
};

export default routes;
