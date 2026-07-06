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
