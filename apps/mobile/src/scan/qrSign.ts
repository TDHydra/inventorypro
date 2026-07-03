import { sha256 } from 'js-sha256';

// QR payload signing (HMAC-SHA256, pure-JS/synchronous so the offline label path
// and the sync scan path both use it without going async). The signing key is a
// shared org secret in app_config (`qr_signing_secret`, admin-set + synced) — so
// this is TAMPER-EVIDENCE against outsiders (a fake INV: sticker printed without
// the app won't verify), NOT forgery-proofing against app users who could extract
// the key. See the #35 plan for the threat-model rationale.
//
// Canonical (legacy/unsigned): `INV:<type>:<value>`  e.g. INV:item:{uuid}
// Signed:                      `INVS:<type>:<value>:<sig>`  (sig = 16 hex of HMAC over the canonical)
// The distinct `INVS:` prefix disambiguates signed from legacy; `sig` is the
// last `:`-segment (hex, no `:`), so it splits cleanly even for unit tags.

const PLAIN = 'INV:';
const SIGNED = 'INVS:';
export const SIG_LEN = 16; // hex chars of the truncated HMAC (64-bit tamper tag)

/** Truncated HMAC-SHA256 (lowercase hex) over the canonical payload. Must match the server (apps/api/src/lib/qrSign.ts). */
export function tagFor(canonical: string, secret: string): string {
  return sha256.hmac(secret, canonical).slice(0, SIG_LEN);
}

/**
 * Sign a canonical `INV:<type>:<value>` → `INVS:<type>:<value>:<sig>`.
 * No-op (returns the input unchanged) when no secret is set or the string isn't a
 * canonical INV payload — so label generation degrades to unsigned/grace cleanly.
 */
export function signPayload(canonical: string, secret: string | null): string {
  if (!secret || !canonical.startsWith(PLAIN)) return canonical;
  return SIGNED + canonical.slice(PLAIN.length) + ':' + tagFor(canonical, secret);
}

export interface QrVerifyConfig {
  secret: string | null;
  requireSigned: boolean;
}

/**
 * Verify a scanned string and return the CANONICAL `INV:` payload to parse, or
 * `null` to REJECT (bad signature, or unsigned when signatures are required).
 * A non-INV string passes through unchanged (barcode fallback handled downstream).
 */
export function verifyScanPayload(scanned: string, cfg: QrVerifyConfig): string | null {
  if (scanned.startsWith(SIGNED)) {
    const body = scanned.slice(SIGNED.length); // "<type>:<value>:<sig>"
    const lastColon = body.lastIndexOf(':');
    if (lastColon <= 0) return null;
    const sig = body.slice(lastColon + 1);
    const canonical = PLAIN + body.slice(0, lastColon);
    if (!cfg.secret) return null; // a signed label but we hold no key → can't trust it
    return tagFor(canonical, cfg.secret) === sig ? canonical : null;
  }
  if (scanned.startsWith(PLAIN)) {
    // Unsigned / legacy label. Reject only when enforcement is on AND a key exists.
    if (cfg.requireSigned && cfg.secret) return null;
    return scanned;
  }
  return scanned; // not an INV payload — leave for the barcode fallback
}
