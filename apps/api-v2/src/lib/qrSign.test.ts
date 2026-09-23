import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagFor, signPayload, getQrSecret } from './qrSign';

// Same interop vector as apps/mobile/src/scan/qrSign.test.ts — asserting the
// server (node:crypto) produces the identical tag the client (js-sha256) does.
const SECRET = 'inv-test-secret-abcdef 0123456789';
const CANON = 'INV:item:11111111-1111-4111-8111-111111111111';
const SIG16 = 'd6c13ecaecbb2653';

test('tagFor matches the cross-platform interop vector', () => {
  assert.equal(tagFor(CANON, SECRET), SIG16);
});

test('signPayload matches the client shape; no-op without a key', () => {
  assert.equal(signPayload(CANON, SECRET), `INVS:item:11111111-1111-4111-8111-111111111111:${SIG16}`);
  assert.equal(signPayload(CANON, null), CANON);
});

test('getQrSecret reads app_config qr_signing_secret (null when unset/error)', async () => {
  const withKey = { query: async () => ({ rows: [{ value: 'abc' }] }) };
  assert.equal(await getQrSecret(withKey as any), 'abc');
  const empty = { query: async () => ({ rows: [] as any[] }) };
  assert.equal(await getQrSecret(empty as any), null);
  const boom = { query: async () => { throw new Error('db'); } };
  assert.equal(await getQrSecret(boom as any), null);
});
