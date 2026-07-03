import { getAppConfig } from '../db/appConfig';
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
