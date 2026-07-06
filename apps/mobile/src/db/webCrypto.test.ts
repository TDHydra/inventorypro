import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptBytes, decryptBytes, SnapshotCryptoError } from './webCrypto';

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
