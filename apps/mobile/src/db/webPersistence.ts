// src/db/webPersistence.ts
// Minimal IndexedDB store for a single key holding the exported sql.js DB file.
//
// SECURITY: the snapshot is encrypted at rest with AES-GCM-256 (see webCrypto.ts)
// using a key that lives only in memory + sessionStorage — so a shared/compromised
// browser or an XSS read of IndexedDB yields ciphertext, not the full dataset.
// The stored blob is [MAGIC][IV][ciphertext]; anything without MAGIC is a legacy
// PLAINTEXT snapshot from before this change and is discarded on read.
import {
  getSnapshotKey,
  getOrCreateSnapshotKey,
  encryptBytes,
  decryptBytes,
  encryptStringToBase64,
  decryptBase64ToString,
  clearSnapshotKey,
} from './webCrypto';

const DB_NAME = 'inventorypro-web';
const STORE = 'kv';
const KEY = 'sqlite-snapshot';

// Magic prefix marking a v1 encrypted snapshot: bytes for "IPE" + version 1.
// A plaintext sql.js export begins with "SQLite format 3\0" (0x53 0x51 0x4c…),
// so it can never collide with this marker.
const MAGIC = new Uint8Array([0x49, 0x50, 0x45, 0x01]); // "IPE" + 0x01

function hasMagic(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return false;
  return true;
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGetRaw(): Promise<Uint8Array | null> {
  return openIdb().then(
    (idb) =>
      new Promise<Uint8Array | null>((resolve, reject) => {
        const tx = idb.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(KEY);
        req.onsuccess = () =>
          resolve(req.result ? new Uint8Array(req.result as ArrayBuffer) : null);
        req.onerror = () => reject(req.error);
      })
  );
}

function idbDeleteRaw(): Promise<void> {
  return openIdb().then(
    (idb) =>
      new Promise<void>((resolve, reject) => {
        const tx = idb.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

/**
 * Load the persisted snapshot as plaintext bytes, or null.
 *
 * Returns null (never throws) when there is nothing to load, when the key is
 * missing/wrong, or when the stored data is a legacy plaintext blob — so the
 * app falls back to a fresh DB + re-download/re-auth instead of crashing. A
 * legacy plaintext blob is deleted so it doesn't sit unencrypted at rest.
 */
export async function loadDbSnapshot(): Promise<Uint8Array | null> {
  let stored: Uint8Array | null;
  try {
    stored = await idbGetRaw();
  } catch {
    return null;
  }
  if (!stored) return null;

  // Legacy plaintext (pre-encryption) snapshot → discard so it re-saves encrypted.
  if (!hasMagic(stored)) {
    try { await idbDeleteRaw(); } catch { /* ignore */ }
    return null;
  }

  try {
    const key = await getSnapshotKey();
    if (!key) return null; // key gone (logout/idle/tab-close) → treat as no snapshot
    const cipher = stored.subarray(MAGIC.length);
    return await decryptBytes(key, cipher);
  } catch {
    // Wrong key / corrupt ciphertext → no usable snapshot.
    return null;
  }
}

/**
 * Encrypt and persist the snapshot as [MAGIC][IV][ciphertext].
 */
export async function saveDbSnapshot(bytes: Uint8Array): Promise<void> {
  const key = await getOrCreateSnapshotKey();
  const cipher = await encryptBytes(key, bytes);
  const blob = new Uint8Array(MAGIC.length + cipher.length);
  blob.set(MAGIC, 0);
  blob.set(cipher, MAGIC.length);

  const idb = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE, 'readwrite');
    // Store a copy as ArrayBuffer (structured-clone friendly).
    tx.objectStore(STORE).put(blob.buffer.slice(0), KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Delete the persisted snapshot AND the in-memory/sessionStorage encryption key,
 * so nothing decryptable is left behind (logout / reset).
 */
export async function clearDbSnapshot(): Promise<void> {
  try {
    await idbDeleteRaw();
  } finally {
    clearSnapshotKey();
  }
}

// ── Encrypted key/value store (JWT + user id at rest) ────────────────────────
// Small sensitive values (the 15-minute JWT, the user id) used to be written to
// IndexedDB in plaintext by session.web.ts, so a local-disk attacker who cannot
// decrypt the snapshot could still lift a live JWT and re-download the dataset.
// These helpers reuse the SAME AES-GCM snapshot key so those values are only
// ciphertext at rest. Stored as `SECURE_PREFIX + base64([IV][ciphertext])`; the
// prefix both marks the value as v1-encrypted and lets a legacy plaintext value
// (a raw JWT / uuid) be detected and discarded on read.
//
// Residual limitation (out of scope, tracked by #42): an attacker with script
// execution in the live page (XSS) can still read the in-memory key and decrypt
// these — this only defends the at-rest disk copy.
const SECURE_PREFIX = 'ipe1:';

function idbGetString(name: string): Promise<string | null> {
  return openIdb().then(
    (idb) =>
      new Promise<string | null>((resolve, reject) => {
        const tx = idb.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(name);
        req.onsuccess = () => resolve(req.result == null ? null : (req.result as string));
        req.onerror = () => reject(req.error);
      })
  );
}

function idbPutString(name: string, value: string): Promise<void> {
  return openIdb().then(
    (idb) =>
      new Promise<void>((resolve, reject) => {
        const tx = idb.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, name);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

function idbDeleteKey(name: string): Promise<void> {
  return openIdb().then(
    (idb) =>
      new Promise<void>((resolve, reject) => {
        const tx = idb.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(name);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

/**
 * Encrypt and persist a small string value under `name`. Always encrypts:
 * getOrCreateSnapshotKey() mints the key if none exists yet, so a value is never
 * written in plaintext.
 */
export async function saveSecureValue(name: string, value: string): Promise<void> {
  const key = await getOrCreateSnapshotKey();
  const b64 = await encryptStringToBase64(key, value);
  await idbPutString(name, SECURE_PREFIX + b64);
}

/**
 * Decrypt and return the string value under `name`, or null.
 *
 * Returns null (never throws) when there is nothing stored, when the snapshot
 * key is missing (logout / idle / fresh tab — treated as logged-out), or when
 * the stored value is a legacy plaintext value from before this change (which is
 * deleted so it doesn't linger unencrypted at rest).
 */
export async function loadSecureValue(name: string): Promise<string | null> {
  let stored: string | null;
  try {
    stored = await idbGetString(name);
  } catch {
    return null;
  }
  if (stored == null) return null;

  // Legacy plaintext (pre-encryption) value → discard; caller re-auths and the
  // next saveSecureValue writes it back encrypted.
  if (!stored.startsWith(SECURE_PREFIX)) {
    try { await idbDeleteKey(name); } catch { /* ignore */ }
    return null;
  }

  try {
    const key = await getSnapshotKey();
    if (!key) return null; // key gone → no decryptable value → treat as logged-out
    return await decryptBase64ToString(key, stored.slice(SECURE_PREFIX.length));
  } catch {
    // Wrong key / corrupt ciphertext → no usable value.
    return null;
  }
}

/** Delete the stored value under `name` (logout / wipe / legacy purge). */
export async function deleteSecureValue(name: string): Promise<void> {
  try {
    await idbDeleteKey(name);
  } catch {
    /* best-effort */
  }
}
