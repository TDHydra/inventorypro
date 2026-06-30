import { FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcrypt';

interface TokenBody {
  user_id: string;
  pin: string;
}

interface RefreshBody {
  refresh_token: string;
}

interface SetPinBody {
  user_id: string;
  pin: string;
}

// In-memory brute-force guard (the API runs as a single container). Keyed per
// target (user_id); a sliding window of failures triggers a temporary lockout.
// Blocks PIN guessing on /auth/token and hammering a single account on /set-pin.
const attempts = new Map<string, { count: number; first: number; lockedUntil: number }>();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60_000;
const LOCK_MS = 15 * 60_000;
function isLocked(key: string): boolean {
  const r = attempts.get(key);
  return !!r && r.lockedUntil > Date.now();
}
function recordFail(key: string): void {
  const now = Date.now();
  const r = attempts.get(key);
  if (!r || now - r.first > WINDOW_MS) { attempts.set(key, { count: 1, first: now, lockedUntil: 0 }); return; }
  r.count += 1;
  if (r.count >= MAX_ATTEMPTS) r.lockedUntil = now + LOCK_MS;
}
function recordSuccess(key: string): void { attempts.delete(key); }

const routes: FastifyPluginAsync = async (fastify) => {
  // GET /auth/roster — PUBLIC login picker roster. Intentionally unauthenticated:
  // a brand-new device has no token yet and needs the list of names to sign in.
  // Returns ONLY the minimum the picker needs — id, name, role (display subtitle),
  // pin_length_required, and pin_set (chooses the set-PIN vs enter-PIN screen).
  // Deliberately NOT exposed: pin_hash, permission_overrides, expires_at, and ALL
  // business data — those require a token and arrive via the post-login full sync.
  // Inactive/expired users are filtered so they never appear as a sign-in option.
  fastify.get('/roster', async (_request, reply) => {
    const { rows } = await fastify.pg.query<{
      id: string; name: string; role: string;
      pin_length_required: number; pin_set: boolean;
    }>(
      `SELECT id, name, role, pin_length_required,
              (pin_hash IS NOT NULL) AS pin_set
         FROM users
        WHERE active = true
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY name`,
      []
    );
    return reply.send({
      users: rows.map(u => ({
        id: u.id,
        name: u.name,
        role: u.role,
        pin_length_required: u.pin_length_required,
        pin_set: u.pin_set ? 1 : 0,
      })),
    });
  });

  // POST /auth/token — verify PIN, return JWT + refresh token
  fastify.post<{ Body: TokenBody }>('/token', {
    schema: {
      body: {
        type: 'object',
        required: ['user_id', 'pin'],
        properties: {
          user_id: { type: 'string' },
          pin: { type: 'string', minLength: 4, maxLength: 8 },
        },
      },
    },
  }, async (request, reply) => {
    const { user_id, pin } = request.body;
    const lockKey = `token:${user_id}`;
    if (isLocked(lockKey)) {
      return reply.status(429).send({ error: 'Too many attempts. Try again in a few minutes.' });
    }

    const { rows } = await fastify.pg.query<{
      id: string; name: string; role: string; pin_hash: string;
      pin_length_required: number; permission_overrides: Record<string, boolean>;
      active: boolean; expires_at: string | null;
    }>(
      `SELECT id, name, role, pin_hash, pin_length_required,
              permission_overrides, active, expires_at
       FROM users WHERE id = $1`,
      [user_id]
    );

    const user = rows[0];

    // Unify the unknown-user and wrong-PIN responses to one generic message so a
    // caller can't enumerate valid accounts. (active/expired/no-PIN below are
    // distinct because the client needs them for sign-in UX.)
    if (!user) {
      recordFail(lockKey);
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    if (!user.active) {
      return reply.status(403).send({ error: 'Account is inactive' });
    }

    if (user.expires_at && new Date(user.expires_at) < new Date()) {
      return reply.status(403).send({ error: 'Account has expired' });
    }

    // No PIN set yet — must go through first-login setup, not normal sign-in.
    if (!user.pin_hash) {
      return reply.status(409).send({ error: 'PIN not set. Complete first-login setup.' });
    }

    const pinMatch = await bcrypt.compare(pin, user.pin_hash);
    if (!pinMatch) {
      recordFail(lockKey);
      return reply.status(401).send({ error: 'Invalid credentials' });
    }
    recordSuccess(lockKey);

    const payload = {
      sub: user.id,
      name: user.name,
      role: user.role,
    };

    const jwt = fastify.jwt.sign(payload, { expiresIn: '15m' });
    const refreshToken = fastify.jwt.sign(
      { sub: user.id, type: 'refresh' },
      { expiresIn: '7d' }
    );

    // Log successful login
    await fastify.pg.query(
      `INSERT INTO activity_log
         (id, user_id, action, entity_type, entity_id, created_at, synced_at)
       VALUES (gen_random_uuid(), $1, 'login', 'user', $1, NOW(), NOW())`,
      [user.id]
    );

    return {
      jwt,
      refreshToken,
      userId: user.id,
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        pin_length_required: user.pin_length_required,
        permission_overrides: user.permission_overrides,
      },
    };
  });

  // POST /auth/set-pin — first-login PIN setup. Only valid while the user has
  // not yet set a PIN (pin_set = false); afterwards they must use /auth/token.
  // Confirmation/double-entry happens on the device before this is called.
  fastify.post<{ Body: SetPinBody }>('/set-pin', {
    schema: {
      body: {
        type: 'object',
        required: ['user_id', 'pin'],
        properties: {
          user_id: { type: 'string' },
          pin: { type: 'string', minLength: 4, maxLength: 8 },
        },
      },
    },
  }, async (request, reply) => {
    const { user_id, pin } = request.body;
    // Rate-limit per target to blunt hammering. NOTE: this does NOT fully close
    // the first-login takeover (an unauthenticated caller can still set the PIN of
    // a not-yet-onboarded user). The proper fix is an admin-issued one-time
    // enrollment token required here — tracked as a follow-up (needs onboarding UX).
    const lockKey = `setpin:${user_id}`;
    if (isLocked(lockKey)) {
      return reply.status(429).send({ error: 'Too many attempts. Try again in a few minutes.' });
    }

    const { rows } = await fastify.pg.query<{
      id: string; name: string; role: string;
      pin_set: boolean; active: boolean; expires_at: string | null;
    }>(
      `SELECT id, name, role, pin_set, active, expires_at FROM users WHERE id = $1`,
      [user_id]
    );
    const user = rows[0];

    if (!user) return reply.status(401).send({ error: 'Invalid credentials' });
    if (!user.active) return reply.status(403).send({ error: 'Account is inactive' });
    if (user.expires_at && new Date(user.expires_at) < new Date()) {
      return reply.status(403).send({ error: 'Account has expired' });
    }
    if (user.pin_set) {
      // Already set — refuse so nobody can overwrite an existing PIN.
      recordFail(lockKey);
      return reply.status(409).send({ error: 'PIN already set' });
    }

    const pinHash = await bcrypt.hash(pin, 10);
    await fastify.pg.query(
      `UPDATE users SET pin_hash = $1, pin_length_required = $2, pin_set = TRUE, updated_at = NOW()
       WHERE id = $3`,
      [pinHash, pin.length, user.id]
    );

    recordSuccess(lockKey);
    const jwt = fastify.jwt.sign({ sub: user.id, name: user.name, role: user.role }, { expiresIn: '15m' });
    const refreshToken = fastify.jwt.sign({ sub: user.id, type: 'refresh' }, { expiresIn: '7d' });

    await fastify.pg.query(
      `INSERT INTO activity_log (id, user_id, action, entity_type, entity_id, created_at, synced_at)
       VALUES (gen_random_uuid(), $1, 'pin_set', 'user', $1, NOW(), NOW())`,
      [user.id]
    );

    return {
      jwt,
      refreshToken,
      userId: user.id,
      user: { id: user.id, name: user.name, role: user.role },
    };
  });

  // POST /auth/refresh — exchange refresh token for new JWT
  fastify.post<{ Body: RefreshBody }>('/refresh', {
    schema: {
      body: {
        type: 'object',
        required: ['refresh_token'],
        properties: { refresh_token: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    let decoded: { sub: string; type: string };
    try {
      decoded = fastify.jwt.verify<{ sub: string; type: string }>(request.body.refresh_token);
    } catch {
      return reply.status(401).send({ error: 'Invalid or expired refresh token' });
    }

    if (decoded.type !== 'refresh') {
      return reply.status(401).send({ error: 'Invalid token type' });
    }

    const { rows } = await fastify.pg.query<{ id: string; name: string; role: string; active: boolean }>(
      `SELECT id, name, role, active FROM users WHERE id = $1`,
      [decoded.sub]
    );

    const user = rows[0];
    if (!user || !user.active) {
      return reply.status(403).send({ error: 'Account inactive' });
    }

    const jwt = fastify.jwt.sign(
      { sub: user.id, name: user.name, role: user.role },
      { expiresIn: '15m' }
    );

    return { jwt };
  });
};

export default routes;
