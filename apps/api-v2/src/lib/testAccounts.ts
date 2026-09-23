/**
 * Server-side gate for public test/demo accounts (`users.is_test`).
 *
 * Test accounts are sandbox-only: their devices keep every change local, and
 * the server enforces the same rule — /sync/push rejects their entries and the
 * global mutating-route hook 403s them. This module answers "is this caller a
 * test account?" from the DB (never the JWT — consistent with the rest of the
 * auth posture) with a short TTL cache so the check costs one indexed PK
 * SELECT per user per minute, not per request.
 */

// Contains "Forbidden" on purpose: the mobile sync engine classifies errors
// matching /forbidden|cannot|not allowed/i as permanent and drops the outbox
// entry instead of retrying it forever (see PERMANENT_REJECTION in
// apps/mobile/src/sync/engine.ts) — a test session must never wedge an outbox.
export const TEST_ACCOUNT_WRITE_ERROR =
  'Forbidden: test accounts are sandbox-only — changes stay on this device';

const DEFAULT_TTL_MS = 60_000;

interface Pg {
  query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
}

export interface TestAccountGate {
  isTestUser(id: string): Promise<boolean>;
}

export function createTestAccountGate(pg: Pg, ttlMs: number = DEFAULT_TTL_MS): TestAccountGate {
  const cache = new Map<string, { value: boolean; expiresAt: number }>();

  return {
    async isTestUser(id: string): Promise<boolean> {
      const hit = cache.get(id);
      if (hit && hit.expiresAt > Date.now()) return hit.value;
      const { rows } = await pg.query(`SELECT is_test FROM users WHERE id = $1`, [id]);
      // Unknown user → not a test account; the route's own auth handles rejection.
      const value = !!(rows[0] as { is_test?: boolean } | undefined)?.is_test;
      cache.set(id, { value, expiresAt: Date.now() + ttlMs });
      return value;
    },
  };
}
