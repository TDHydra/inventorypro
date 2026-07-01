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
  enrollment_code: string;
}

// In-memory brute-force guard (the API runs as a single container). Keyed per
// target (user_id); a sliding window of failures triggers a temporary lockout.
// Blocks PIN guessing on /auth/token and hammering a single account on /set-pin.
const attempts = new Map<string, { count: number; first: number; lockedUntil: number }>();
const WINDOW_MS = 15 * 60_000;

// Exponential backoff once a target has racked up enough failures: no lock below
// the threshold, then a small initial delay doubling per additional failure,
// capped at 1h. Pure + exported so it can be unit-tested without touching the
// in-memory Map.
export function nextLockMs(count: number): number {
  if (count < 3) return 0;
  return Math.min(60 * 60_000, 15_000 * 2 ** (count - 3)); // 15s,30s,60s… cap 1h
}
function isLocked(key: string): boolean {
  const r = attempts.get(key);
  return !!r && r.lockedUntil > Date.now();
}
function recordFail(key: string): void {
  const now = Date.now();
  const r = attempts.get(key);
  if (!r) { attempts.set(key, { count: 1, first: now, lockedUntil: 0 }); return; }
  if (now - r.first > WINDOW_MS) {
    // Window since the first failure elapsed — DECAY the retained count instead
    // of fully resetting it. A full reset lets an attacker pace ≤(threshold-1)
    // fails per window forever without ever locking; halving still lets a
    // genuinely stale record cool down, but escalation state isn't shed for free.
    const decayed = Math.max(0, Math.floor(r.count / 2));
    attempts.set(key, { count: decayed + 1, first: now, lockedUntil: 0 });
    return;
  }
  r.count += 1;
  const ms = nextLockMs(r.count);
  if (ms > 0) r.lockedUntil = now + ms;
}
function recordSuccess(key: string): void { attempts.delete(key); }

// IP-keyed rate limit for the public /auth/roster endpoint (no auth to gate it,
// so this is the only thing standing between it and enumeration/scraping abuse).
// Reuses the same `attempts` map/window; count-only, no lockout escalation.
// Kept generous: request.ip is the real client now that trustProxy is on
// (see index.ts), but a shared-NAT office still puts many users behind one
// public IP, so a normal morning login rush shouldn't trip this.
const ROSTER_LIMIT = 200;
function rosterRateLimited(ip: string): boolean {
  const key = `roster:${ip}`;
  const now = Date.now();
  const r = attempts.get(key);
  if (!r || now - r.first > WINDOW_MS) {
    attempts.set(key, { count: 1, first: now, lockedUntil: 0 });
    return false;
  }
  r.count += 1;
  return r.count > ROSTER_LIMIT;
}

const routes: FastifyPluginAsync = async (fastify) => {
  // GET /auth/roster — PUBLIC login picker roster. Intentionally unauthenticated:
  // a brand-new device has no token yet and needs the list of names to sign in.
  // Returns ONLY the minimum the picker needs — id, name, role (display subtitle),
  // pin_length_required, and pin_set (chooses the set-PIN vs enter-PIN screen).
  // Deliberately NOT exposed: pin_hash, permission_overrides, expires_at, and ALL
  // business data — those require a token and arrive via the post-login full sync.
  // Inactive/expired users are filtered so they never appear as a sign-in option.
  fastify.get('/roster', async (request, reply) => {
    if (rosterRateLimited(request.ip)) {
      return reply.status(429).send({ error: 'Too many requests. Try again later.' });
    }
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
        required: ['user_id', 'pin', 'enrollment_code'],
        properties: {
          user_id: { type: 'string' },
          pin: { type: 'string', minLength: 4, maxLength: 8 },
          enrollment_code: { type: 'string', minLength: 4, maxLength: 12 },
        },
      },
    },
  }, async (request, reply) => {
    const { user_id, pin } = request.body;
    // Rate-limit per target to blunt hammering. The admin-issued one-time
    // enrollment code (below) closes the first-login takeover: an unauthenticated
    // caller can no longer set the PIN of a not-yet-onboarded user without it.
    const lockKey = `setpin:${user_id}`;
    if (isLocked(lockKey)) {
      return reply.status(429).send({ error: 'Too many attempts. Try again in a few minutes.' });
    }

    const { rows } = await fastify.pg.query<{
      id: string; name: string; role: string;
      pin_set: boolean; active: boolean; expires_at: string | null;
      enrollment_code_hash: string | null;
    }>(
      `SELECT id, name, role, pin_set, active, expires_at, enrollment_code_hash FROM users WHERE id = $1`,
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

    if (!user.enrollment_code_hash) {
      recordFail(lockKey);
      return reply.status(403).send({ error: 'Enrollment not available for this account' });
    }
    const codeOk = await bcrypt.compare(request.body.enrollment_code, user.enrollment_code_hash);
    if (!codeOk) {
      recordFail(lockKey);
      return reply.status(401).send({ error: 'Invalid enrollment code' });
    }

    const pinHash = await bcrypt.hash(pin, 10);
    await fastify.pg.query(
      `UPDATE users SET pin_hash = $1, pin_length_required = $2, pin_set = TRUE, enrollment_code_hash = NULL, updated_at = NOW()
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

    const { rows } = await fastify.pg.query<{ id: string; name: string; role: string; active: boolean; expires_at: string | null }>(
      `SELECT id, name, role, active, expires_at FROM users WHERE id = $1`,
      [decoded.sub]
    );

    const user = rows[0];
    if (!user || !user.active || (user.expires_at && new Date(user.expires_at) < new Date())) {
      return reply.status(403).send({ error: 'Account inactive or expired' });
    }

    const jwt = fastify.jwt.sign(
      { sub: user.id, name: user.name, role: user.role },
      { expiresIn: '15m' }
    );

    return { jwt };
  });
};

export default routes;
