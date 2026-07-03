import { createHmac } from 'node:crypto';

// Server side of QR payload signing — MUST stay byte-for-byte compatible with the
// client (apps/mobile/src/scan/qrSign.ts): same HMAC-SHA256, lowercase hex, same
// 16-char truncation, same `INVS:<type>:<value>:<sig>` shape over the canonical
// `INV:<type>:<value>`. The shared secret lives in app_config (`qr_signing_secret`,
// admin-set + synced), read via getQrSecret(pg).

const PLAIN = 'INV:';
const SIGNED = 'INVS:';
export const SIG_LEN = 16;

export function tagFor(canonical: string, secret: string): string {
  return createHmac('sha256', secret).update(canonical).digest('hex').slice(0, SIG_LEN);
}

/** Sign `INV:<type>:<value>` → `INVS:<type>:<value>:<sig>`; no-op without a key. */
export function signPayload(canonical: string, secret: string | null): string {
  if (!secret || !canonical.startsWith(PLAIN)) return canonical;
  return SIGNED + canonical.slice(PLAIN.length) + ':' + tagFor(canonical, secret);
}

type Pg = { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> };

/** The org signing key from app_config, or null when signing isn't enabled. */
export async function getQrSecret(pg: Pg): Promise<string | null> {
  try {
    const { rows } = await pg.query(`SELECT value FROM app_config WHERE key = 'qr_signing_secret'`, []);
    const v = rows[0]?.value;
    return v ? String(v) : null;
  } catch {
    return null;
  }
}
