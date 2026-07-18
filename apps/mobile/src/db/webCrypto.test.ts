import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptBytes,
  decryptBytes,
  encryptStringToBase64,
  decryptBase64ToString,
  SnapshotCryptoError,
} from './webCrypto';

// getOrCreateSnapshotKey()/getSnapshotKey() depend on sessionStorage, which is a
// browser-only global — so these tests exercise the pure crypto primitives with
// a directly-generated key. Node 20's global crypto.subtle backs WebCrypto here.

async function freshKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

test('encryptBytes → decryptBytes round-trips arbitrary bytes', async () => {
  const key = await freshKey();
  const plain = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0, 1, 2, 250, 255]); // includes "SQLi"
  const blob = await encryptBytes(key, plain);
  // Ciphertext is prefixed with a 12-byte IV and differs from the plaintext.
  assert.ok(blob.length > plain.length + 12 - 1);
  assert.notDeepEqual(Array.from(blob.subarray(12, 12 + plain.length)), Array.from(plain));
  const back = await decryptBytes(key, blob);
  assert.deepEqual(Array.from(back), Array.from(plain));
});

test('each encryption uses a fresh random IV (ciphertexts differ)', async () => {
  const key = await freshKey();
  const plain = new Uint8Array([1, 2, 3, 4, 5]);
  const a = await encryptBytes(key, plain);
  const b = await encryptBytes(key, plain);
  assert.notDeepEqual(Array.from(a), Array.from(b));
});

test('decryptBytes with the wrong key throws SnapshotCryptoError', async () => {
  const k1 = await freshKey();
  const k2 = await freshKey();
  const blob = await encryptBytes(k1, new Uint8Array([9, 8, 7]));
  await assert.rejects(() => decryptBytes(k2, blob), (e: unknown) => e instanceof SnapshotCryptoError);
});

test('decryptBytes on a too-short blob throws SnapshotCryptoError', async () => {
  const key = await freshKey();
  await assert.rejects(() => decryptBytes(key, new Uint8Array([1, 2, 3])), SnapshotCryptoError);
});

test('encryptStringToBase64 → decryptBase64ToString round-trips JWT-like text', async () => {
  const key = await freshKey();
  // A realistic JWT (three dot-separated base64url segments) plus a uuid.
  const jwt =
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIiwiZXhwIjo5OTk5OTk5OTk5fQ.c2lnbmF0dXJl';
  const b64 = await encryptStringToBase64(key, jwt);
  // Stored form is opaque base64 — it must NOT contain the plaintext JWT.
  assert.ok(!b64.includes(jwt));
  assert.equal(await decryptBase64ToString(key, b64), jwt);

  const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  assert.equal(await decryptBase64ToString(key, await encryptStringToBase64(key, uuid)), uuid);
});

test('encryptStringToBase64 preserves multi-byte UTF-8', async () => {
  const key = await freshKey();
  const s = 'café — 名前 — 🔐';
  assert.equal(await decryptBase64ToString(key, await encryptStringToBase64(key, s)), s);
});

test('decryptBase64ToString with the wrong key throws SnapshotCryptoError', async () => {
  const k1 = await freshKey();
  const k2 = await freshKey();
  const b64 = await encryptStringToBase64(k1, 'secret-token');
  await assert.rejects(
    () => decryptBase64ToString(k2, b64),
    (e: unknown) => e instanceof SnapshotCryptoError,
  );
});
