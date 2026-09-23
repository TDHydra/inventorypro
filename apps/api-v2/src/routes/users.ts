import { FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcrypt';
import { randomInt } from 'node:crypto';
import { requirePermission, userHasPermission, canActOnTarget, canAssignRole } from '../lib/permissions';
import { sendEnrollmentCodeEmail } from '../lib/mail';
import { EMAIL_SCHEMA } from '../lib/schemaShapes';
import { touchTeamsAndLocationsIfViewPermsChanged } from '../lib/syncPolicy';

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

// Resolve the caller's CURRENT role from the DB (never the JWT claim). Returns
// null when the caller is unknown — callers must fail closed on null (the tier
// helpers treat a missing role as tier 0 anyway, but null lets us 403 early).
async function callerRole(fastify: any, userId: string): Promise<string | null> {
  const { rows } = await fastify.pg.query(`SELECT role FROM users WHERE id = $1`, [userId]);
  return rows[0]?.role ?? null;
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
      `SELECT id, name, role, pin_length_required, permission_overrides, active, expires_at, email, created_at, updated_at
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

    // Tier guard (security-critical): you may NOT create a user whose role sits at
    // a tier ABOVE your own (apex: only a full_admin can mint another full_admin).
    // Caller role resolved from the DB; fails closed on unknown caller/role.
    const creatorRole = await callerRole(fastify, (request.user as { sub: string }).sub);
    if (!canAssignRole(creatorRole, role)) {
      return reply.status(403).send({ error: 'Cannot create a user with a role at or above your own level.' });
    }

    // Creating a privileged role or any explicit permission override is itself a
    // privilege grant → require manage_roles_permissions, not just manage_users.
    if (PRIVILEGED_ROLES.has(role) || Object.keys(permission_overrides).length > 0) {
      const can = await callerCan(fastify, (request.user as { sub: string }).sub);
      if (!can || !can('manage_roles_permissions')) {
        return reply.status(403).send({ error: 'Creating an admin role or custom permissions requires the roles & permissions permission.' });
      }
    }
    // Seed pin_length_required from the role's configured minimum so the login
    // roster demands the right PIN length at enrollment (auth /set-pin also
    // enforces it server-side). Falls back to 4 for a role with no settings row.
    const { rows: roleSettingRows } = await fastify.pg.query<{ min_pin_length: number }>(
      `SELECT min_pin_length FROM role_settings WHERE role = $1`,
      [role]
    );
    const roleMinPin = roleSettingRows[0]?.min_pin_length ?? 4;
    const pinHash = pin ? await bcrypt.hash(pin, 10) : null;
    const pinLength = pin ? pin.length : roleMinPin;
    const pinSet = !!pin;

    const { code: enrollmentCode, hash: enrollmentCodeHash } = await issueEnrollmentCode();

    const { rows } = await fastify.pg.query(
      `INSERT INTO users (name, role, pin_hash, pin_length_required, pin_set, permission_overrides, expires_at, enrollment_code_hash, enrollment_code_expires_at)
       VALUES ($1, $2::user_role, $3, $4, $5, $6::jsonb, $7, $8, NOW() + INTERVAL '7 days')
       RETURNING id, name, role, pin_length_required, pin_set, active, created_at`,
      [name, role, pinHash, pinLength, pinSet, JSON.stringify(permission_overrides), expires_at ?? null, enrollmentCodeHash]
    );
    return reply.status(201).send({ ...rows[0], enrollment_code: enrollmentCode });
  });

  // PATCH /users/:id — update user
  fastify.patch<{ Params: { id: string }; Body: UpdateUserBody }>('/:id', {
    ...auth,
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 64 },
        },
      },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          role: { type: 'string', minLength: 1, maxLength: 64 },
          pin: { type: 'string', minLength: 4, maxLength: 8 },
          reset_pin: { type: 'boolean' },
          active: { type: 'boolean' },
          // Nullable: clearing an expiry is a legitimate PATCH (expires_at → null).
          expires_at: { type: ['string', 'null'], maxLength: 40 },
          permission_overrides: { type: 'object' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const targetId = request.params.id;
    const can = await callerCan(fastify, userId);
    if (!can || !can('manage_users')) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const { name, role, pin, reset_pin, active, expires_at, permission_overrides } = request.body;

    // Tier guard (security-critical). This PATCH previously never fetched the
    // target's role, so a manage_users holder could modify a user ABOVE their own
    // tier. Resolve BOTH the caller's and the target's current role from the DB
    // and enforce that the caller may act on the target (>= tier; apex full_admin
    // only touchable by a full_admin). Applies to EVERY change — role, active,
    // expires_at, permission_overrides, name, dashboard_preset_id. Fails closed:
    // unknown caller role or a missing target row → denied.
    const patcherRole = await callerRole(fastify, userId);
    const { rows: targetRoleRows } = await fastify.pg.query(
      `SELECT role FROM users WHERE id = $1`, [targetId]);
    const targetRole = targetRoleRows[0]?.role ?? null;
    if (targetRole == null) return reply.status(404).send({ error: 'User not found' });
    if (!canActOnTarget(patcherRole, targetRole)) {
      return reply.status(403).send({ error: 'You cannot modify a user at or above your own level.' });
    }
    // When the role itself is being changed, the NEW role must also be at or below
    // the caller's tier (can't promote anyone — including up to your own apex).
    if (role !== undefined && !canAssignRole(patcherRole, role)) {
      return reply.status(403).send({ error: 'Cannot assign a role at or above your own level.' });
    }

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
    if (active !== undefined) { updates.push(`active = $${i++}`); values.push(active); }
    if (expires_at !== undefined) { updates.push(`expires_at = $${i++}`); values.push(expires_at); }
    if (permission_overrides !== undefined) { updates.push(`permission_overrides = $${i++}::jsonb`); values.push(JSON.stringify(permission_overrides)); }

    // Role change must also move pin_length_required to the new role's minimum
    // (role_settings.min_pin_length) — mirrors mobile's setUserRole. When that
    // differs from the user's CURRENT required length, the existing PIN no
    // longer satisfies the new role's policy, so it needs to be wiped below
    // exactly like an explicit reset_pin. Skip the auto pin_length_required set
    // when an explicit `pin` is also supplied in this request — that branch
    // below sets pin_length_required itself, from the new PIN's own length.
    let pinLengthMismatch = false;
    if (role !== undefined) {
      updates.push(`role = $${i++}::user_role`); values.push(role);
      if (pin === undefined) {
        const { rows: roleRows } = await fastify.pg.query(
          `SELECT u.pin_length_required AS current_length, rs.min_pin_length
             FROM users u LEFT JOIN role_settings rs ON rs.role = $2
            WHERE u.id = $1`,
          [targetId, role]
        );
        const minPinLength = roleRows[0]?.min_pin_length ?? 4;
        pinLengthMismatch = roleRows[0] != null && roleRows[0].current_length !== minPinLength;
        updates.push(`pin_length_required = $${i++}`); values.push(minPinLength);
      }
    }

    let newEnrollmentCode: string | undefined;
    if (reset_pin || pinLengthMismatch) {
      // Architecture: no admin-chosen PINs. Reset clears the hash so the user
      // sets and confirms a fresh PIN themselves on next sign-in (pin_set=false).
      // It also must reissue an enrollment code — pin_hash/pin_set alone leave
      // the account dead-ended, since /auth/set-pin requires a code and the
      // original one-time code was already consumed (nulled) at first onboarding.
      // A role change that changes the required PIN length triggers this same
      // path (pinLengthMismatch) — a same-length role change does NOT wipe it.
      const issued = await issueEnrollmentCode();
      newEnrollmentCode = issued.code;
      updates.push(`pin_hash = NULL`, `pin_set = FALSE`, `enrollment_code_hash = $${i++}`, `enrollment_code_expires_at = NOW() + INTERVAL '7 days'`);
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

    // #204: this REST path is a SECOND writer of users.permission_overrides
    // (the generic sync outbox in routes/sync.ts is the first) — without this,
    // an admin editing permissions through the REST-backed user editor (rather
    // than the sync outbox) would silently create the exact stale/stub-cache
    // bug this fix exists to prevent. See touchTeamsAndLocationsIfViewPermsChanged's
    // doc comment for the full rationale.
    if (permission_overrides !== undefined) {
      await touchTeamsAndLocationsIfViewPermsChanged(fastify.pg, permission_overrides);
    }

    // Server-authoritative audit row (#172) for an EXPLICIT admin-initiated PIN
    // reset only — a role change that implicitly resets the PIN (pinLengthMismatch)
    // is already covered by the caller's own 'user_role_changed' log, so it is
    // deliberately not double-logged here. entity_id is the target (UUID-only per
    // lib/activityLog.ts rules); the target's name goes in note.
    if (reset_pin) {
      await fastify.pg.query(
        `INSERT INTO activity_log (id, user_id, action, entity_type, entity_id, created_at, synced_at, note, metadata)
         VALUES (gen_random_uuid(), $1, 'user_pin_reset', 'user', $2, NOW(), NOW(), $3, $4)`,
        [userId, targetId, rows[0].name, JSON.stringify({ request_id: request.id })]
      );
    }
    return newEnrollmentCode ? { ...rows[0], enrollment_code: newEnrollmentCode } : rows[0];
  });

  // POST /users/:id/reset-enrollment-code — reissue a one-time enrollment code for
  // a user who has NOT yet set a PIN, and email it to them. This is for the
  // pre-onboarding case where the original code was lost/expired before first
  // sign-in: it re-arms /auth/set-pin WITHOUT touching an existing PIN. A user who
  // has ALREADY set a PIN must use the PIN-reset path (PATCH reset_pin) instead —
  // that clears the PIN and issues its own code — so this endpoint 409s for them.
  // Gated like other admin user actions (manage_users OR set_pins). The plaintext
  // code is returned to the admin (endpoint is admin-gated) so onboarding still
  // works if email delivery is down/unconfigured.
  fastify.post<{ Params: { id: string }; Body: { email?: string } }>('/:id/reset-enrollment-code', {
    ...auth,
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
      },
      body: {
        type: 'object',
        properties: {
          // Optional recipient override; falls back to the stored users.email.
          email: EMAIL_SCHEMA,
        },
      },
    },
  }, async (request, reply) => {
    const callerId = (request.user as { sub: string }).sub;
    const can = await callerCan(fastify, callerId);
    if (!can || !(can('manage_users') || can('set_pins'))) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const targetId = request.params.id;
    const { rows } = await fastify.pg.query<{
      id: string; name: string; role: string; email: string | null; pin_hash: string | null;
    }>(
      `SELECT id, name, role, email, pin_hash FROM users WHERE id = $1`,
      [targetId],
    );
    const user = rows[0];
    if (!user) return reply.status(404).send({ error: 'User not found' });

    // Tier guard. This endpoint re-arms /auth/set-pin AND returns the plaintext
    // code to the caller, so without it a `set_pins` holder could mint an
    // enrollment code for a full_admin who has never signed in and use it to take
    // that account — escalating past their own tier. Nobody may act on a user
    // above their level. Resolve both roles from the DB, never the JWT claim.
    const actorRole = await callerRole(fastify, callerId);
    if (!canActOnTarget(actorRole, user.role)) {
      return reply.status(403).send({ error: 'Forbidden: target user is at or above your level' });
    }

    // Only valid before the user has a PIN — otherwise this would be a silent
    // parallel path to overwrite/undermine an active account's onboarding state.
    if (user.pin_hash) {
      return reply.status(409).send({ error: 'User has already set a PIN. Use PIN reset instead.' });
    }

    const recipient = (request.body?.email?.trim() || user.email?.trim()) ?? null;

    const { code, hash } = await issueEnrollmentCode();
    await fastify.pg.query(
      `UPDATE users SET enrollment_code_hash = $1, enrollment_code_expires_at = NOW() + INTERVAL '7 days', updated_at = NOW() WHERE id = $2`,
      [hash, targetId],
    );

    // Server-authoritative audit row (#172) — same 'user_pin_reset' action as the
    // PATCH reset_pin path (both re-arm PIN onboarding for the target). entity_id
    // is the target (UUID-only per lib/activityLog.ts rules); target name in note.
    await fastify.pg.query(
      `INSERT INTO activity_log (id, user_id, action, entity_type, entity_id, created_at, synced_at, note, metadata)
       VALUES (gen_random_uuid(), $1, 'user_pin_reset', 'user', $2, NOW(), NOW(), $3, $4)`,
      [callerId, targetId, user.name, JSON.stringify({ request_id: request.id })]
    );

    const mail = recipient ? await sendEnrollmentCodeEmail(recipient, code, user.name) : { sent: false };
    return { emailed: mail.sent, code };
  });
};

export default routes;
