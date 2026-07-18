// src/db/webCrypto.ts
//
// At-rest encryption primitives for the Expo Web build. The sql.js database is
// exported and persisted to IndexedDB (see webPersistence.ts). Left unencrypted,
// that snapshot is a full, durably-on-disk copy of the local dataset that anyone
// with filesystem access to the browser profile could read straight off disk. We
// encrypt it with AES-GCM-256.
//
// THREAT MODEL — read before trusting this. The encryption here defends the
// AT-REST DISK COPY against an OFFLINE attacker: someone who can read the
// IndexedDB files on the profile but is NOT executing script in a live, logged-in
// page. It does NOT defend against XSS or any other same-origin script running in
// the live page. The AES key is reachable from JS for the whole session (raw
// base64 in sessionStorage, plus an imported CryptoKey in memory), so injected
// script can simply decrypt everything — the snapshot AND the encrypted session
// values in webPersistence. There is no client-only fix for that: a key the page
// can use, the page's attacker can use too. XSS must be mitigated elsewhere (CSP,
// output encoding, short-lived JWTs), not by this module.
//
// Why the key lives in sessionStorage and not IndexedDB / localStorage:
//   • sessionStorage is scoped to the tab and cleared when the tab/browser
//     closes; it is not written durably to disk the way IndexedDB / localStorage
//     are. Keeping the key OUT of durable on-disk storage is exactly what the
//     offline-disk defense needs — the key should not sit on disk next to the
//     ciphertext it unlocks. (Caveat: browsers may still spill sessionStorage to
//     disk for session-restore, so treat it as "far less durable", not "never on
//     disk".) It also survives a same-tab reload, so a refresh doesn't force a
//     full re-download / re-auth.
//   • On logout / idle we call clearSnapshotKey() to drop the key immediately,
//     which makes the on-disk ciphertext undecryptable even before IndexedDB is
//     wiped.
//
// WebCrypto only — no dependencies. Everything guards on the browser globals so
// importing this from a `.web.ts` twin can never crash a native bundle.

const SESSION_KEY_NAME = 'ip-web-dbkey';
const IV_BYTES = 12; // AES-GCM standard nonce length

/**
 * Typed error thrown when there is no usable snapshot key or decryption fails
 * (wrong key / corrupt ciphertext). Callers treat this as "no usable snapshot"
 * and fall back to re-download / re-auth rather than crashing.
 */
export class SnapshotCryptoError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'SnapshotCryptoError';
  }
}

// In-memory handle to the imported CryptoKey. Imported non-extractable, so its
// raw bytes can't be pulled back out via WebCrypto exportKey() even when the
// handle is referenced. Note this only raises the bar for grabbing the key object
// itself — the raw base64 still sits in sessionStorage this session (see the
// threat-model note above), so it does nothing against same-origin XSS.
let inMemoryKey: CryptoKey | null = null;

// De-dupes concurrent first-use callers of getOrCreateSnapshotKey (e.g.
// saveSession encrypting the JWT and user id in parallel, or a snapshot save
// racing login). Without it two callers can each generate a *different* random
// key and only the last one gets persisted to sessionStorage — leaving half the
// values encrypted under a key that's gone on reload.
let keyInit: Promise<CryptoKey> | null = null;

function subtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) {
    throw new SnapshotCryptoError('WebCrypto SubtleCrypto is unavailable in this environment');
  }
  return c.subtle;
}

function getRandomBytes(len: number): Uint8Array {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.getRandomValues) {
    throw new SnapshotCryptoError('WebCrypto getRandomValues is unavailable');
  }
  return c.getRandomValues(new Uint8Array(len));
}

function getSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    // Accessing sessionStorage can throw in sandboxed contexts.
    return null;
  }
}

// ── base64 <-> bytes (raw AES key material) ──────────────────────────────────
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  if (typeof btoa === 'function') return btoa(bin);
  // Node fallback (tests / SSR).
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

async function importRawKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey('raw', raw as unknown as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Return the existing snapshot key (from memory, else re-imported from
 * sessionStorage) WITHOUT creating one. Returns null when no key exists — used
 * by load paths so a missing key just means "no decryptable snapshot".
 */
export async function getSnapshotKey(): Promise<CryptoKey | null> {
  if (inMemoryKey) return inMemoryKey;
  const store = getSessionStorage();
  const b64 = store?.getItem(SESSION_KEY_NAME);
  if (!b64) return null;
  try {
    inMemoryKey = await importRawKey(base64ToBytes(b64));
    return inMemoryKey;
  } catch (err) {
    throw new SnapshotCryptoError('Failed to import stored snapshot key', err);
  }
}

/**
 * Return the snapshot key, generating and persisting a fresh random AES-GCM-256
 * key on first use. The raw key is exported to base64 and stashed in
 * sessionStorage so it survives a same-tab reload; see the threat-model note at
 * the top of this file for why sessionStorage (offline-disk defense, NOT XSS).
 * The in-memory CryptoKey is non-extractable, but the raw base64 in
 * sessionStorage is readable by any same-origin script, so this provides no
 * protection against an attacker already executing script in the live page.
 * Used by save paths.
 */
export async function getOrCreateSnapshotKey(): Promise<CryptoKey> {
  if (inMemoryKey) return inMemoryKey;
  // Single-flight the create path so parallel first-use callers share one key.
  const inFlight = keyInit;
  if (inFlight) return inFlight;

  const pending = (async (): Promise<CryptoKey> => {
    const existing = await getSnapshotKey();
    if (existing) return existing;

    // Generate extractable so we can export raw for sessionStorage, then
    // re-import as non-extractable for actual use.
    const genKey = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]);
    const raw = new Uint8Array(await subtle().exportKey('raw', genKey));
    const store = getSessionStorage();
    if (store) {
      try {
        store.setItem(SESSION_KEY_NAME, bytesToBase64(raw));
      } catch {
        // If sessionStorage is full/blocked the key stays memory-only:
        // encryption still works this session, a reload just forces
        // re-download. Acceptable.
      }
    }
    const imported = await importRawKey(raw);
    // Best-effort hardening: wipe the raw key bytes from this local buffer now
    // that they're both imported (into a non-extractable CryptoKey) and, if
    // storage was available, persisted as base64. This only shortens the lifetime
    // of the *binary* copy in the JS heap — the base64 copy in sessionStorage
    // necessarily remains for reload survival and is the real XSS exposure.
    raw.fill(0);
    inMemoryKey = imported;
    return imported;
  })();

  keyInit = pending;
  // Clear the in-flight handle once settled so a later logout/clear can't be
  // shadowed by a stale resolved promise. Guarded so a concurrent re-entry that
  // installed a newer promise isn't clobbered.
  void pending
    .finally(() => {
      if (keyInit === pending) keyInit = null;
    })
    .catch(() => {
      // Rejection is surfaced to the awaiting caller via the returned `pending`;
      // this side-chain only resets keyInit, so swallow to avoid a duplicate
      // unhandled-rejection warning.
    });
  return pending;
}

/**
 * Encrypt `data` with AES-GCM. Output is [12-byte random IV][ciphertext+tag].
 */
export async function encryptBytes(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = getRandomBytes(IV_BYTES);
  let ct: ArrayBuffer;
  try {
    ct = await subtle().encrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, key, data as unknown as BufferSource);
  } catch (err) {
    throw new SnapshotCryptoError('Snapshot encryption failed', err);
  }
  const out = new Uint8Array(IV_BYTES + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), IV_BYTES);
  return out;
}

/**
 * Decrypt an [IV][ciphertext] blob produced by encryptBytes. Throws
 * SnapshotCryptoError on a wrong key / corrupt data (callers treat as null).
 */
export async function decryptBytes(key: CryptoKey, blob: Uint8Array): Promise<Uint8Array> {
  if (blob.length <= IV_BYTES) {
    throw new SnapshotCryptoError('Snapshot ciphertext too short to contain IV');
  }
  const iv = blob.subarray(0, IV_BYTES);
  const ct = blob.subarray(IV_BYTES);
  try {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, key, ct as unknown as BufferSource);
    return new Uint8Array(pt);
  } catch (err) {
    throw new SnapshotCryptoError('Snapshot decryption failed (wrong key or corrupt data)', err);
  }
}

// ── string helpers (JWT / user id at rest) ───────────────────────────────────
// UTF-8 text ⇄ base64 ciphertext, using the same AES-GCM primitives as the
// snapshot. Kept key-parameterised (rather than fetching the snapshot key
// internally) so they stay pure and unit-testable in Node like encrypt/decrypt.

/** Encrypt a UTF-8 string to a base64 [IV][ciphertext] blob. */
export async function encryptStringToBase64(key: CryptoKey, value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  return bytesToBase64(await encryptBytes(key, bytes));
}

/**
 * Decrypt a base64 blob produced by encryptStringToBase64 back to its UTF-8
 * string. Throws SnapshotCryptoError on a wrong key / corrupt data.
 */
export async function decryptBase64ToString(key: CryptoKey, b64: string): Promise<string> {
  const plain = await decryptBytes(key, base64ToBytes(b64));
  return new TextDecoder().decode(plain);
}

/** Drop the snapshot key from sessionStorage and memory (logout / idle wipe). */
export function clearSnapshotKey(): void {
  inMemoryKey = null;
  keyInit = null;
  const store = getSessionStorage();
  try {
    store?.removeItem(SESSION_KEY_NAME);
  } catch {
    /* ignore */
  }
}
