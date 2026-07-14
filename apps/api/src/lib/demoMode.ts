/**
 * Server-side gate for the demo-mode kill switch (`app_config.demo_mode`,
 * migration 047).
 *
 * When demo mode is OFF the public demo/test accounts are hidden from the
 * login roster and unenrollable via /auth/set-pin. Same shape as
 * lib/testAccounts.ts: DB-resolved (never a JWT claim) behind a short TTL
 * cache, so the check costs one indexed SELECT per minute, not per request.
 *
 * A MISSING row means ON — clients and the server must treat absence as
 * enabled (see 047_demo_mode_flag.sql). Only an explicit '0' disables.
 */

const DEFAULT_TTL_MS = 60_000;

interface Pg {
  query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
}

export interface DemoModeGate {
  isEnabled(): Promise<boolean>;
  /** Drop the cached value (call after PATCH /audit/demo-mode upserts the row). */
  invalidate(): void;
}

export function createDemoModeGate(pg: Pg, ttlMs: number = DEFAULT_TTL_MS): DemoModeGate {
  let cached: { value: boolean; expiresAt: number } | null = null;

  return {
    async isEnabled(): Promise<boolean> {
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      const { rows } = await pg.query(
        `SELECT value FROM app_config WHERE key = 'demo_mode'`, [],
      );
      // Missing row → enabled; anything but an explicit '0' → enabled.
      const value = (rows[0] as { value?: string } | undefined)?.value !== '0';
      cached = { value, expiresAt: Date.now() + ttlMs };
      return value;
    },
    invalidate(): void {
      cached = null;
    },
  };
}
