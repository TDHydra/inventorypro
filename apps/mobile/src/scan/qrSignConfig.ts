import { getAppConfig, setAppConfigLocal } from '../db/appConfig';
import { appendOutbox } from '../sync/outbox';
import { signPayload, verifyScanPayload, type QrVerifyConfig } from './qrSign';

// App-integration layer for QR signing: reads the admin-managed signing config
// from synced app_config and applies the pure helpers in ./qrSign. Kept separate
// so ./qrSign stays free of the op-sqlite/DB import chain and is unit-testable
// under node:test.

/** Live signing config from synced app_config (admin-managed). */
export function getQrSignConfig(): QrVerifyConfig {
  return {
    secret: getAppConfig('qr_signing_secret') || null,
    requireSigned: getAppConfig('require_signed_qr') === '1',
  };
}

/** Sign a canonical INV: payload with the current org key (no-op if unset). Used by label producers. */
export function signWithConfig(canonical: string): string {
  return signPayload(canonical, getQrSignConfig().secret);
}

/** Verify a scanned string against the current config → canonical INV: to parse, or null to reject. Used by resolveScan. */
export function verifyWithConfig(scanned: string): string | null {
  return verifyScanPayload(scanned, getQrSignConfig());
}

// ── Admin actions (write local + push through outbox so config syncs to every
// device — the setMaintenanceMode pattern; app_config writes are admin-gated
// server-side via PRIVILEGED_TABLE_PERM). ────────────────────────────────────
function pushConfig(key: string, value: string): void {
  setAppConfigLocal(key, value);
  appendOutbox('INSERT', 'app_config', { key, value, updated_at: new Date().toISOString() });
}

/** Generate a fresh 256-bit random signing key (hex) — uses the RNG polyfill (index.ts). */
export function generateQrSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Admin: set/rotate the org QR signing key (syncs to all devices). */
export function setQrSigningSecret(secret: string): void { pushConfig('qr_signing_secret', secret); }

/** Admin: turn signing off — labels print unsigned again (secret cleared). */
export function clearQrSigning(): void { pushConfig('qr_signing_secret', ''); }

/** Admin: enforce signed labels on scan (strict) vs allow unsigned legacy (grace). */
export function setRequireSignedQr(on: boolean): void { pushConfig('require_signed_qr', on ? '1' : '0'); }
