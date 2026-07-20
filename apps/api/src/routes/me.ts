// Self-service profile routes (role-dashboards spec §5): the authenticated
// caller edits their OWN pin/email/phone — no admin permission involved, the
// target row is always request.user.sub. All routes are JWT-authenticated and
// rate-limited per caller via the shared bucket limiter (lib/rateLimit), the
// same guard family the auth routes use.
import { FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcrypt';
import { randomInt } from 'node:crypto';
import { overLimit } from '../lib/rateLimit';
import { isWeakPin } from '../lib/weakPin';
import { sendEmailChangeCodeEmail, type SendMailResult } from '../lib/mail';
import { EMAIL_SCHEMA } from '../lib/schemaShapes';

// Same 15-minute window the auth brute-force guard uses. Limits are per USER
// (the JWT sub), not per IP — these routes only ever act on the caller's own
// row, so the target key and the caller key are the same thing.
const WINDOW_MS = 15 * 60_000;
// change-pin and email/confirm both verify a secret (current PIN / 6-digit
// code), so their caps are deliberately tight — 10 tries per window is ample
// for a human and useless for an online guess of a 6-digit space.
export const VERIFY_LIMIT = 10;
// Each request-code call can send an email; keep the cap low so a stolen JWT
// can't turn the API into a mail cannon pointed at an arbitrary address.
export const REQUEST_CODE_LIMIT = 5;
// Phone is just a profile write — generous, DOS-guard-level only.
export const PHONE_LIMIT = 30;

// Pending email changes expire quickly — the code was just emailed; 10 minutes
// covers a slow inbox without leaving a stale claim on an address lying around.
const CODE_TTL = `10 minutes`;

interface ChangePinBody { currentPin: string; newPin: string }
interface RequestCodeBody { email: string }
interface ConfirmEmailBody { email: string; code?: string }
interface PhoneBody { phone: string | null }

// Normalize a phone number: strip separators (spaces, dashes, dots, parens),
// keep an optional leading '+', and require 7–15 digits after stripping —
// mirrors the client-side rule in apps/mobile (spec §4, no SMS verification,
// format-only). Returns the normalized string or null when invalid. Exported
// for unit tests.
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim();
  const plus = trimmed.startsWith('+');
  const rest = plus ? trimmed.slice(1) : trimmed;
  const digits = rest.replace(/[\s\-().]/g, '');
  if (!/^[0-9]{7,15}$/.test(digits)) return null;
  return (plus ? '+' : '') + digits;
}

export interface MeRoutesOpts {
  // Test seam (the AuthRoutesOpts/demoGate pattern): production omits this and
  // gets the real SMTP sender; tests inject a stub to capture the code and to
  // drive the {sent:false} fallback without touching SMTP env.
  sendCode?: (to: string, code: string, userName: string) => Promise<SendMailResult>;
}

const routes: FastifyPluginAsync<MeRoutesOpts> = async (fastify, opts) => {
  const auth = { preHandler: [(fastify as any).authenticate] };
  const sendCode = opts.sendCode ?? sendEmailChangeCodeEmail;

  // POST /me/change-pin — verify the current PIN, validate the new one with the
  // SAME rules as enrollment (exact required length, digits only, not weak),
  // reject new == current, store the new hash. 204 on success; PIN is never
  // returned or stored anywhere but the bcrypt hash.
  fastify.post<{ Body: ChangePinBody }>('/change-pin', {
    ...auth,
    schema: {
      body: {
        type: 'object',
        required: ['currentPin', 'newPin'],
        properties: {
          currentPin: { type: 'string', minLength: 4, maxLength: 8 },
          newPin: { type: 'string', minLength: 4, maxLength: 8 },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    if (overLimit(`me:chpin:${userId}`, VERIFY_LIMIT, WINDOW_MS)) {
      return reply.status(429).send({ error: 'Too many attempts. Try again later.' });
    }
    const { currentPin, newPin } = request.body;

    const { rows } = await fastify.pg.query<{ pin_hash: string | null; pin_length_required: number }>(
      `SELECT pin_hash, pin_length_required FROM users WHERE id = $1`,
      [userId]
    );
    const user = rows[0];
    // No row (deleted mid-session) or no PIN yet (enrollment not finished) —
    // there is no "current PIN" to verify, so this flow doesn't apply.
    if (!user || !user.pin_hash) {
      return reply.status(403).send({ error: 'No PIN set for this account.' });
    }

    const currentOk = await bcrypt.compare(currentPin, user.pin_hash);
    if (!currentOk) {
      return reply.status(403).send({ error: 'Current PIN is incorrect.' });
    }

    // Enrollment rules, server-side (mirrors mobile validatePinFormat against
    // users.pin_length_required — the user's own established PIN length).
    if (!/^[0-9]+$/.test(newPin)) {
      return reply.status(400).send({ error: 'PIN must contain only digits.' });
    }
    if (newPin.length !== user.pin_length_required) {
      return reply.status(400).send({ error: `PIN must be exactly ${user.pin_length_required} digits.` });
    }
    // Weak-PIN gate only where a PIN is CHOSEN — same policy as /auth/set-pin.
    if (isWeakPin(newPin)) {
      return reply.status(400).send({
        error: 'That PIN is too easy to guess. Avoid repeated digits and simple sequences like 1234.',
      });
    }
    if (await bcrypt.compare(newPin, user.pin_hash)) {
      return reply.status(400).send({ error: 'New PIN must be different from your current PIN.' });
    }

    const pinHash = await bcrypt.hash(newPin, 10);
    // pin_hash isn't synced, and the length didn't change (enforced above), but
    // bump updated_at anyway so the row's sync watermark reflects the edit.
    await fastify.pg.query(
      `UPDATE users SET pin_hash = $1, updated_at = NOW() WHERE id = $2`,
      [pinHash, userId]
    );
    return reply.status(204).send();
  });

  // POST /me/email/request-code — start an email change. Emails a 6-digit code
  // to the NEW address (proves the caller controls it) and stores the pending
  // change (upsert — one pending change per user). When SMTP is unavailable the
  // pending row is stored with a NULL code_hash and {sent:false} is returned;
  // the client falls back to type-twice confirm and /me/email/confirm accepts
  // the matching email without a code.
  fastify.post<{ Body: RequestCodeBody }>('/email/request-code', {
    ...auth,
    schema: {
      body: {
        type: 'object',
        required: ['email'],
        properties: { email: EMAIL_SCHEMA },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    if (overLimit(`me:emailcode:${userId}`, REQUEST_CODE_LIMIT, WINDOW_MS)) {
      return reply.status(429).send({ error: 'Too many requests. Try again later.' });
    }
    const email = request.body.email.trim();

    const { rows } = await fastify.pg.query<{ name: string }>(
      `SELECT name FROM users WHERE id = $1`,
      [userId]
    );
    if (!rows[0]) return reply.status(403).send({ error: 'Unknown account' });

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const mail = await sendCode(email, code, rows[0].name);
    // The codeless-confirm fallback (NULL code_hash) applies ONLY when SMTP is
    // UNCONFIGURED (spec §5). A configured-but-failing transport (outage,
    // timeout) must NOT downgrade to codeless confirm — that would let any
    // authenticated caller commit an arbitrary email address without ever
    // proving control of it, for the duration of the outage. Surface those as
    // a 502 (no pending row written/overwritten) and let the user retry.
    if (!mail.sent && mail.reason !== 'smtp-not-configured') {
      return reply.status(502).send({ error: 'Could not send the verification email. Try again shortly.' });
    }
    const codeHash = mail.sent ? await bcrypt.hash(code, 10) : null;

    await fastify.pg.query(
      `INSERT INTO user_email_changes (user_id, email, code_hash, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '${CODE_TTL}')
       ON CONFLICT (user_id) DO UPDATE
         SET email = EXCLUDED.email, code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at`,
      [userId, email, codeHash]
    );
    return reply.send({ sent: mail.sent });
  });

  // POST /me/email/confirm — commit a pending email change. Requires an
  // unexpired pending row whose email matches; the code must match its bcrypt
  // hash EXCEPT when code_hash is NULL (SMTP-unavailable fallback). On success
  // users.email is set and updated_at bumped so the change propagates via sync.
  fastify.post<{ Body: ConfirmEmailBody }>('/email/confirm', {
    ...auth,
    schema: {
      body: {
        type: 'object',
        required: ['email'],
        properties: {
          email: EMAIL_SCHEMA,
          code: { type: 'string', pattern: '^[0-9]{6}$' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    if (overLimit(`me:emailconfirm:${userId}`, VERIFY_LIMIT, WINDOW_MS)) {
      return reply.status(429).send({ error: 'Too many attempts. Try again later.' });
    }
    const { email, code } = request.body;

    const { rows } = await fastify.pg.query<{ email: string; code_hash: string | null; expires_at: string }>(
      `SELECT email, code_hash, expires_at FROM user_email_changes WHERE user_id = $1`,
      [userId]
    );
    const pending = rows[0];
    if (!pending) {
      return reply.status(400).send({ error: 'No pending email change. Request a code first.' });
    }
    if (new Date(pending.expires_at) < new Date()) {
      return reply.status(400).send({ error: 'Code expired. Request a new one.' });
    }
    if (pending.email.trim().toLowerCase() !== email.trim().toLowerCase()) {
      return reply.status(400).send({ error: 'Email does not match the pending change.' });
    }
    if (pending.code_hash !== null) {
      if (!code) return reply.status(400).send({ error: 'Verification code required.' });
      if (!(await bcrypt.compare(code, pending.code_hash))) {
        return reply.status(403).send({ error: 'Invalid verification code.' });
      }
    }

    // updated_at = NOW() is what makes the new email flow to every device via
    // incremental /sync/pull (users is watermark-synced on updated_at).
    await fastify.pg.query(
      `UPDATE users SET email = $1, updated_at = NOW() WHERE id = $2`,
      [pending.email, userId]
    );
    await fastify.pg.query(
      `DELETE FROM user_email_changes WHERE user_id = $1`,
      [userId]
    );
    return reply.status(204).send();
  });

  // PATCH /me/phone — set or clear the caller's phone number. Validates and
  // stores the NORMALIZED form (optional leading '+', 7–15 digits, separators
  // stripped); null clears. Bumps updated_at so the change syncs.
  // PATCH (not the spec draft's PUT) deliberately: the global write wall +
  // per-user mut: bucket in index.ts intercept POST/PATCH/DELETE, and the CORS
  // method allowlist excludes PUT — a PUT route would bypass the test-account
  // read-only wall and be unusable from the web client.
  fastify.patch<{ Body: PhoneBody }>('/phone', {
    ...auth,
    schema: {
      body: {
        type: 'object',
        required: ['phone'],
        properties: {
          // Bounded well above the normalized max so a heavily-separated but
          // valid number (e.g. "+1 (555) 123-4567") isn't schema-rejected.
          phone: { type: ['string', 'null'], maxLength: 40 },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    if (overLimit(`me:phone:${userId}`, PHONE_LIMIT, WINDOW_MS)) {
      return reply.status(429).send({ error: 'Too many requests. Try again later.' });
    }
    const { phone } = request.body;

    let normalized: string | null = null;
    if (phone !== null) {
      normalized = normalizePhone(phone);
      if (normalized === null) {
        return reply.status(400).send({
          error: 'Invalid phone number. Use 7–15 digits, with an optional leading +.',
        });
      }
    }

    await fastify.pg.query(
      `UPDATE users SET phone = $1, updated_at = NOW() WHERE id = $2`,
      [normalized, userId]
    );
    return reply.status(204).send();
  });
};

export default routes;
