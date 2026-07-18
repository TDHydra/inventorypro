# InventoryPro Web Version Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a browser build of InventoryPro from the same `apps/mobile` codebase — offline-first, with camera + keyboard-wedge + WebHID scanning — installable as a PWA and self-hosted on Unraid beside the API.

**Architecture:** Add an Expo Web target (`react-native-web` + `react-dom`). Native-only leaf modules are replaced per-platform via Metro's `.web.ts(x)` resolution; shared screens/queries/sync code are untouched. The synchronous data layer is preserved by a `sql.js` (WASM) `getDb()` shim persisted to IndexedDB. Auth/scanner/geo/etc. get `.web` shims with identical exported APIs.

**Tech Stack:** Expo SDK 56, react-native-web, react-dom, expo-router, `sql.js`, `@zxing/browser`, WebHID/WebUSB, IndexedDB, nginx (Docker on Unraid).

## Global Constraints

- Package manager is **pnpm only** (never npm).
- Typecheck gate per task: `cd /home/tdpotato/inventorypro/apps/mobile && npx tsc --noEmit -p tsconfig.json` → exit 0.
- Web build gate (where noted): `cd /home/tdpotato/inventorypro/apps/mobile && npx expo export -p web` → completes with no "Unable to resolve" / native-module errors.
- Not a git repo — skip `git commit` steps; the per-task gate is the typecheck (+ web export where noted).
- **op-sqlite must never be bundled on web.** It may be imported as a *value* only in `schema.ts` (native). Everywhere else its `DB` type must be `import type` (erased by Babel) or a neutral alias.
- `.web.ts(x)` files shadow the base on web; base `.ts(x)` is used on native. Do not add `.native.ts` unless a native-specific shadow is required.
- Same synchronous DB contract: `getDb().executeSync(sql, params?)` returns `{ rows: Array<Record<string, unknown>> }`. All existing call sites stay unchanged.
- Decisions (from spec): same codebase Expo Web; full offline-first; scanners = camera + keyboard-wedge + WebHID/WebUSB (last is desktop Chrome/Edge only); self-hosted nginx on Unraid; reuse PIN→JWT + `/sync`.
- "Office" stays `type IN ('Shop','Office')` (already implemented).
- Dev workflow: keep Metro in watch mode; verify web via `expo start --web` / `expo export -p web`.

---

## File Structure

**New (web shims & infra):**
- `src/db/webPersistence.ts` — tiny IndexedDB get/set for the DB snapshot.
- `src/db/schema.web.ts` — sql.js synchronous `getDb()`/`initDb()`/`resetLocalDb()` + the same `rowsAs`/`toBindable`/`bindParams`; runs the existing migrations.
- `src/db/types.ts` — neutral `SqlDb` type alias used by migrations/queries (replaces direct op-sqlite `DB` type imports).
- `src/components/BarcodeScanner.web.tsx` — camera scanner (BarcodeDetector + ZXing fallback).
- `src/scan/hidScanner.web.ts` — WebHID/WebUSB connect (desktop Chrome/Edge).
- `src/auth/session.web.ts` — IndexedDB token store.
- `src/auth/biometric.web.ts` — WebAuthn-or-PIN.
- `src/hooks/useCurrentPosition.web.ts` — `navigator.geolocation`.
- `src/sync/netinfo.web.ts` (or guarded shim) — `navigator.onLine`.
- `src/platform/webNotify.web.ts`, `src/labels/printLabel.web.ts`, media `.web` shims.
- `public/sql-wasm.wasm` — sql.js WASM asset (served at `/sql-wasm.wasm`).
- `public/manifest.json`, `public/sw.js` (or Workbox config) — PWA.
- `deploy/web/Dockerfile`, `deploy/web/nginx.conf`, `deploy/web/docker-compose.yml` — Unraid.

**Modified:**
- `package.json` — add web deps.
- `app.json` — confirm `web.bundler: metro`, add web `output`, PWA meta.
- `src/db/schema.ts` — change the `DB` value import to `import type` where it leaks; keep op-sqlite value import (native only).
- `src/db/migrations/*.ts` + `src/db/queries/*.ts` — swap any `import { DB } from '@op-engineering/op-sqlite'` to `import type { SqlDb } from '../types'` (type-only).
- `src/sync/engine.ts` — NetInfo usage behind the web-safe shim.

---

## PHASE A — Runs offline-first (bundles, sql.js DB, auth, netinfo)

### Task A1: Add web dependencies + neutral DB type

**Files:**
- Modify: `package.json`
- Create: `src/db/types.ts`

**Interfaces:**
- Produces: `SqlDb` — neutral type with `executeSync(sql: string, params?: unknown[]): { rows: any[] }` and `close(): void`.

- [ ] **Step 1: Add deps** (pnpm, from repo root)

```bash
cd /home/tdpotato/inventorypro
pnpm --filter mobile add react-native-web react-dom sql.js @zxing/browser
pnpm --filter mobile add -D @types/react-dom @types/sql.js
```
Pin `react-dom` to the React major already installed (React 19.2.x). If `react-native-web` warns about React 19, install the latest `react-native-web` that supports it; record the resolved versions.

- [ ] **Step 2: Create the neutral DB type**

```ts
// src/db/types.ts
// Platform-neutral shape of the database handle. Native = op-sqlite DB,
// web = the sql.js shim. Both expose this synchronous surface, so migrations
// and queries depend on THIS type (never op-sqlite directly) to keep op-sqlite
// out of the web bundle.
export interface SqlDb {
  executeSync(sql: string, params?: unknown[]): { rows: any[] };
  close(): void;
}
```

- [ ] **Step 3: Typecheck gate** → exit 0.

---

### Task A2: Isolate op-sqlite to native-only

**Files:**
- Modify: `src/db/schema.ts`, every `src/db/migrations/*.ts`, any `src/db/queries/*.ts` importing op-sqlite's `DB`.

- [ ] **Step 1: Find every op-sqlite import**

```bash
cd /home/tdpotato/inventorypro/apps/mobile
grep -rn "@op-engineering/op-sqlite" src/
```
Expected: `schema.ts` (value import of `open`, `DB`) + migrations/queries importing `DB` as a type.

- [ ] **Step 2: In `schema.ts`, split the value vs type import**

```ts
import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';
```
(`open` is a value used only here; `DB` becomes type-only so it's erased.)

- [ ] **Step 3: In each migration + query file, replace the op-sqlite `DB` type with the neutral one**

Change `import { DB } from '@op-engineering/op-sqlite';` (or `import type { DB } ...`) to:
```ts
import type { SqlDb } from '../types';
```
and replace `DB` with `SqlDb` in signatures (e.g. `up: (db: SqlDb) => void`). For files one directory deeper, adjust the relative path (`../../db/types`).

- [ ] **Step 4: Typecheck gate** → exit 0. (Native still compiles; op-sqlite value import remains only in `schema.ts`.)

---

### Task A3: IndexedDB persistence helper

**Files:**
- Create: `src/db/webPersistence.ts`

**Interfaces:**
- Produces: `loadDbSnapshot(): Promise<Uint8Array | null>`, `saveDbSnapshot(bytes: Uint8Array): Promise<void>`, `clearDbSnapshot(): Promise<void>`.

- [ ] **Step 1: Create the helper**

```ts
// src/db/webPersistence.ts
// Minimal IndexedDB store for a single key holding the exported sql.js DB file.
const DB_NAME = 'inventorypro-web';
const STORE = 'kv';
const KEY = 'sqlite-snapshot';

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadDbSnapshot(): Promise<Uint8Array | null> {
  const idb = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve(req.result ? new Uint8Array(req.result as ArrayBuffer) : null);
    req.onerror = () => reject(req.error);
  });
}

export async function saveDbSnapshot(bytes: Uint8Array): Promise<void> {
  const idb = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE, 'readwrite');
    // Store a copy as ArrayBuffer (structured-clone friendly).
    tx.objectStore(STORE).put(bytes.buffer.slice(0), KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearDbSnapshot(): Promise<void> {
  const idb = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
```

- [ ] **Step 2: Typecheck gate** → exit 0.

---

### Task A4: The sql.js synchronous DB shim — `schema.web.ts`

**Files:**
- Create: `src/db/schema.web.ts`
- Create: `public/sql-wasm.wasm` (copy from the installed package)

**Interfaces:**
- Produces (drop-in for `./schema`): `getDb(): SqlDb`, `initDb(): Promise<void>`, `resetLocalDb(): Promise<void>`, `rowsAs<T>(rows): T[]`, `toBindable(v): Bindable`, `bindParams(params): Bindable[]`.
- Consumes: `loadDbSnapshot`/`saveDbSnapshot`/`clearDbSnapshot` (A3), `SqlDb` (A1), the existing migration modules.

- [ ] **Step 1: Stage the WASM asset**

```bash
cd /home/tdpotato/inventorypro/apps/mobile
mkdir -p public
# NOTE: this sql.js build's browser glue fetches `sql-wasm-browser.wasm` (NOT
# `sql-wasm.wasm`). Staging the wrong name → DB init aborts → blank screen.
cp node_modules/sql.js/dist/sql-wasm-browser.wasm public/sql-wasm-browser.wasm
```
(Expo serves `public/` at the web root, so the file is reachable at `/sql-wasm-browser.wasm` in dev and in the nginx deploy. `locateFile: f => '/' + f` returns `/sql-wasm-browser.wasm` since emscripten passes that exact filename.)

- [ ] **Step 2: Create the shim**

```ts
// src/db/schema.web.ts
import initSqlJs, { type Database } from 'sql.js';
import type { SqlDb } from './types';
import { loadDbSnapshot, saveDbSnapshot, clearDbSnapshot } from './webPersistence';

let raw: Database | null = null;       // sql.js Database
let wrapped: SqlDb | null = null;
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
export let persistenceDisabled = false; // surfaced to UI for the "won't save" banner

function isRead(sql: string): boolean {
  const head = sql.trim().slice(0, 8).toUpperCase();
  return head.startsWith('SELECT') || head.startsWith('PRAGMA') || head.startsWith('EXPLAIN');
}

function scheduleSave() {
  if (persistenceDisabled || !raw) return;
  dirty = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void flush(); }, 500);
}

async function flush(): Promise<void> {
  if (!dirty || !raw || persistenceDisabled) return;
  dirty = false;
  try { await saveDbSnapshot(raw.export()); }
  catch { persistenceDisabled = true; }
}

// Build the op-sqlite-compatible wrapper. executeSync returns { rows: object[] }.
function wrap(database: Database): SqlDb {
  return {
    executeSync(sql: string, params?: unknown[]) {
      const rows: any[] = [];
      if (params && params.length > 0) {
        // Single parameterized statement → prepared statement.
        const stmt = database.prepare(sql);
        stmt.bind(params as any[]);
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
      } else {
        // No params: may be multi-statement DDL (migrations) → exec.
        const res = database.exec(sql);
        for (const r of res) {
          for (const v of r.values) {
            const obj: Record<string, unknown> = {};
            r.columns.forEach((c, i) => { obj[c] = v[i]; });
            rows.push(obj);
          }
        }
      }
      if (!isRead(sql)) scheduleSave();
      return { rows };
    },
    close() { void flush(); database.close(); },
  };
}

export function getDb(): SqlDb {
  if (!wrapped) throw new Error('Database not initialized. Call initDb() first.');
  return wrapped;
}

export async function initDb(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: (f: string) => '/' + f });
  let snapshot: Uint8Array | null = null;
  try { snapshot = await loadDbSnapshot(); }
  catch { persistenceDisabled = true; }
  raw = snapshot ? new SQL.Database(snapshot) : new SQL.Database();
  wrapped = wrap(raw);
  await runMigrations(wrapped);
  installFlushHooks();
}

export async function resetLocalDb(): Promise<void> {
  if (raw) { raw.close(); raw = null; wrapped = null; }
  try { await clearDbSnapshot(); } catch { /* ignore */ }
  await initDb();
}

let hooksInstalled = false;
function installFlushHooks() {
  if (hooksInstalled || typeof window === 'undefined') return;
  hooksInstalled = true;
  // Flush before the tab is hidden/closed so a refresh never loses writes.
  window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void flush(); });
  window.addEventListener('pagehide', () => { void flush(); });
}

// ── migrations (mirrors schema.ts; uses the same migration modules) ──────────
interface Migration { version: number; up: (db: SqlDb) => void; }

async function loadMigrations(): Promise<Migration[]> {
  const m = await Promise.all([
    import('./migrations/001_initial'), import('./migrations/002_inventory_fields'),
    import('./migrations/003_user_pin_set'), import('./migrations/004_inventory_kind_location_owner'),
    import('./migrations/005_item_category_returnable'), import('./migrations/006_equipment_units'),
    import('./migrations/007_location_active'), import('./migrations/008_job_workorder_fields'),
    import('./migrations/009_location_coords'), import('./migrations/010_app_config'),
    import('./migrations/011_taxonomy_types'), import('./migrations/012_product_classes_owner'),
    import('./migrations/013_hardening'), import('./migrations/014_role_permissions'),
    import('./migrations/015_team_managers'), import('./migrations/016_job_insurance'),
    import('./migrations/017_location_types_item_home'), import('./migrations/018_item_pack_size'),
    import('./migrations/019_repairs'), import('./migrations/020_location_has_shelves'),
    import('./migrations/021_taxonomy_dedup'),
  ]);
  return m.map(x => x.migration as Migration).sort((a, b) => a.version - b.version);
}

async function runMigrations(database: SqlDb): Promise<void> {
  database.executeSync(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const versionRow = database.executeSync(`SELECT value FROM app_settings WHERE key = 'schema_version'`).rows[0] as { value: string } | undefined;
  const currentVersion = versionRow ? parseInt(versionRow.value, 10) : 0;
  const pending = (await loadMigrations()).filter(mig => mig.version > currentVersion);
  if (pending.length === 0) { console.log(`[DB:web] schema v${currentVersion} ready`); return; }
  for (const mig of pending) {
    database.executeSync('BEGIN');
    try {
      mig.up(database);
      database.executeSync(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schema_version', ?)`, [String(mig.version)]);
      database.executeSync('COMMIT');
    } catch (err) {
      database.executeSync('ROLLBACK');
      throw new Error(`web migration v${mig.version} failed: ${(err as Error).message}`);
    }
  }
  await flush(); // persist freshly-migrated schema immediately
  console.log(`[DB:web] schema v${pending[pending.length - 1].version} ready`);
}

// ── shared helpers (identical to schema.ts) ──────────────────────────────────
export function rowsAs<T>(rows: unknown[]): T[] { return rows as unknown as T[]; }
type Bindable = string | number | null | Uint8Array;
export function toBindable(value: unknown): Bindable {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}
export function bindParams(params: readonly unknown[]): Bindable[] { return params.map(toBindable); }
```

> Note: sql.js binds `Uint8Array` for blobs (not `ArrayBuffer`); `toBindable` reflects that. Migrations using multi-statement strings hit the `exec` branch (no params); parameterized queries hit the prepared-statement branch.

- [ ] **Step 3: Typecheck gate** → exit 0.

- [ ] **Step 4: Web export gate** → `npx expo export -p web` completes without resolving op-sqlite.

---

### Task A5: Web session/token store — `session.web.ts`

**Files:**
- Read first: `src/auth/session.ts` (mirror its exact exports/signatures).
- Create: `src/auth/session.web.ts`

- [ ] **Step 1: Match the native API**

```bash
grep -nE "export (async )?function|export const" /home/tdpotato/inventorypro/apps/mobile/src/auth/session.ts
```
Re-implement every exported symbol (`saveSession`, `getValidJwt`, `clearSession`, `getRefreshToken`, `getCurrentUserId`, and any others) with identical signatures, backed by the IndexedDB kv store from `webPersistence` (add generic `idbGet(key)`/`idbSet(key,val)`/`idbDel(key)` helpers there, or a small inline store). Token-refresh logic (calling the API) is copied verbatim from `session.ts` — only the storage calls change from `SecureStore.*Async` to IndexedDB.

- [ ] **Step 2: Typecheck + web export gates** → exit 0 / clean.

---

### Task A6: NetInfo web shim

**Files:**
- Read first: `src/sync/engine.ts` (find the NetInfo import + usage).
- Create: `src/sync/netinfo.web.ts` (or convert the engine's import to a thin local module that has a `.web` shadow).

- [ ] **Step 1: Provide a `.web` shadow with the same shape the engine uses**

If the engine imports `@react-native-community/netinfo` directly, introduce `src/sync/netinfo.ts` (native re-export of NetInfo) + `src/sync/netinfo.web.ts`:
```ts
// src/sync/netinfo.web.ts — minimal NetInfo-compatible surface used by engine.ts
type State = { isConnected: boolean | null };
export function addEventListener(cb: (s: State) => void): () => void {
  const on = () => cb({ isConnected: navigator.onLine });
  window.addEventListener('online', on);
  window.addEventListener('offline', on);
  on();
  return () => { window.removeEventListener('online', on); window.removeEventListener('offline', on); };
}
export async function fetch(): Promise<State> { return { isConnected: navigator.onLine }; }
```
Update `engine.ts` to import from `./netinfo` instead of the package directly (native `netinfo.ts` re-exports the real package). Keep the exact method shape the engine relies on.

- [ ] **Step 2: Typecheck + web export gates.**

- [ ] **Step 3: Manual gate (Phase A milestone)** — `npx expo start --web`, open in Chrome: app boots, `[DB:web] schema vNN ready` logs, PIN→JWT login works, data pulls/syncs, reload preserves data (IndexedDB), airplane-mode (offline) still loads and queues writes.

---

## PHASE B — Scanning

### Task B1: Web camera scanner — `BarcodeScanner.web.tsx`

**Files:**
- Read first: `src/components/BarcodeScanner.tsx` (props `{ active, onScanned, onClose }`).
- Create: `src/components/BarcodeScanner.web.tsx`

**Interfaces:**
- Produces: `BarcodeScanner` (same props as native) so all callers (hub, BarcodeInput) work unchanged.

- [ ] **Step 1: Implement camera + detection**

A component that, when `active`, requests `navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })`, renders the stream in a `<video autoplay playsinline>` (RNW passes through DOM props), and decodes:
- If `'BarcodeDetector' in window`: poll frames via `requestAnimationFrame` → `detector.detect(video)`; on a code, debounce 1500ms (ignore same code), call `onScanned(code)`.
- Else (iOS Safari/Firefox): use `@zxing/browser` `BrowserMultiFormatReader.decodeFromVideoDevice(...)`; same debounce/`onScanned`.
Show a close control calling `onClose`; stop all tracks and the ZXing reader on unmount/`active=false`. Torch via `track.applyConstraints({ advanced: [{ torch: true }] })` when supported, else hide the button. On permission denial, render a message + `onClose`.

- [ ] **Step 2: Typecheck + web export gates.**

- [ ] **Step 3: Manual gate** — Android Chrome (BarcodeDetector path) and iOS Safari (ZXing path): scanning a code drives the hub's scan loop exactly like native.

---

### Task B2: Keyboard-wedge validation (no code change)

**Files:** none (validation only).

- [ ] **Step 1:** Confirm `src/components/USBScanner.tsx` (hidden input capturing newline) renders and fires `onScanned` on web. On a desktop/iPad with a USB/Bluetooth HID scanner, scanning into a focused field yields the code + Enter. Document the focus requirement. If RNW drops the hidden input's focusability, give it `style={{ position:'absolute', opacity:0 }}` instead of off-screen positioning.

---

### Task B3: WebHID/WebUSB scanner — `hidScanner.web.ts`

**Files:**
- Create: `src/scan/hidScanner.web.ts`
- Integrate: a "Connect scanner" control in the hub (desktop only).

**Interfaces:**
- Produces: `isHidSupported(): boolean`, `connectHidScanner(onCode: (code: string) => void): Promise<() => void>` (returns a disconnect fn).

- [ ] **Step 1: Implement WebHID connect**

```ts
// src/scan/hidScanner.web.ts
export function isHidSupported(): boolean {
  return typeof navigator !== 'undefined' && 'hid' in navigator;
}

// Requests a HID device and streams decoded ASCII lines. Most HID scanners in
// "USB HID POS" mode emit keyboard usage codes; we accumulate until Enter.
export async function connectHidScanner(onCode: (code: string) => void): Promise<() => void> {
  const nav = navigator as any;
  const [device] = await nav.hid.requestDevice({ filters: [] });
  if (!device) throw new Error('No scanner selected.');
  await device.open();
  let buf = '';
  const handler = (e: any) => {
    const byte = new Uint8Array(e.data.buffer)[0];
    if (byte === 13 || byte === 10) { if (buf) { onCode(buf); buf = ''; } }
    else if (byte >= 32) buf += String.fromCharCode(byte);
  };
  device.addEventListener('inputreport', handler);
  return () => { device.removeEventListener('inputreport', handler); void device.close(); };
}
```
> HID usage→ASCII mapping varies by scanner; if a device reports raw usage codes rather than ASCII, document that the keyboard-wedge path (B2) is the supported fallback. Keep this behind feature detection.

- [ ] **Step 2: Hub integration** — in `app/(app)/(hub)/index.tsx`, when `isHidSupported()`, show a "Connect scanner" button that calls `connectHidScanner(onScan)` and stores the disconnect fn; hidden when unsupported (iOS/Safari). `onScan` is the existing scan handler.

- [ ] **Step 3: Typecheck + web export gates.**

---

## PHASE C — Remaining shims

### Task C1: Geolocation — `useCurrentPosition.web.ts`
- Read `src/hooks/useCurrentPosition.ts`; create `.web` with the same returned shape (`{ coords, request }`) backed by `navigator.geolocation.getCurrentPosition`. Map to `{ latitude, longitude, accuracy }`. Typecheck + export gates.

### Task C2: Biometric — `biometric.web.ts`
- Read `src/auth/biometric.ts`; create `.web` exposing the same API. Use WebAuthn platform authenticator when `window.PublicKeyCredential` exists; otherwise resolve so the app falls back to PIN re-entry (return "unavailable" exactly as native does when no hardware). Typecheck + export gates.

### Task C3: Media — `MediaGallery` web path
- Read `src/components/MediaGallery.tsx`; provide a `.web` shim (or `Platform.OS === 'web'` branch) using `<input type="file" accept="image/*" capture="environment">` for capture/pick, object URLs for preview, and the existing API upload path. Disable native-only file-system calls on web. Typecheck + export gates.

### Task C4: Notifications + print
- `src/notifications/localAlerts.ts` → `.web` using the Web Notifications API (request permission; no-op if denied).
- `src/labels/printLabel.ts` → `.web` using `window.print()` of a generated label DOM (or a PDF blob). Typecheck + export gates.

---

## PHASE D — PWA + Unraid deploy

### Task D1: PWA manifest + service worker
**Files:** `public/manifest.json`, `public/sw.js`, `app.json` (link manifest, web meta).
- [ ] Manifest: name, short_name, icons (192/512), `display: standalone`, theme/background colors.
- [ ] Service worker: precache the app shell + `/sql-wasm.wasm`; runtime-cache static assets; network-first for `/sync` API calls (never cache writes). Register it from the web entry. Verify "installable" in Chrome devtools → Application.
- [ ] Web export gate + manual install test (desktop + iOS "Add to Home Screen").

### Task D2: nginx container
**Files:** `deploy/web/Dockerfile`, `deploy/web/nginx.conf`.
- [ ] Dockerfile: build stage runs `pnpm --filter mobile exec expo export -p web` → copies `dist/` into an `nginx:alpine` stage.
- [ ] `nginx.conf`: serve static; SPA fallback `try_files $uri /index.html`; correct MIME for `.wasm` (`application/wasm`); long-cache hashed assets, no-cache `index.html`/`sw.js`. **No COOP/COEP headers needed** (sql.js doesn't use SharedArrayBuffer).
- [ ] Build + run locally: `docker build -t inventorypro-web deploy/web && docker run -p 8088:80 inventorypro-web`; load `localhost:8088`, confirm app + `/sql-wasm.wasm` served.

### Task D3: Unraid compose + API CORS
**Files:** `deploy/web/docker-compose.yml`, API CORS config.
- [ ] Compose service for the Unraid stack alongside the API (same network); map a host port.
- [ ] If served cross-origin from the API, add the web origin to the API CORS allow-list; otherwise reverse-proxy `/api` to the API from nginx so it's same-origin. Confirm PIN→JWT login + `/sync/pull|push` work from the deployed web app.
- [ ] Final manual matrix: Chrome desktop, iPad Safari, iPhone Safari — login, offline boot, persistence across reload, sync round-trip, camera scan (both detection paths), keyboard-wedge scan, WebHID scan (desktop), PWA install.

---

## Self-Review (completed during authoring)

- **Spec coverage:** same-codebase Expo Web (A1) ✓; sync DB shim sql.js + IndexedDB (A3,A4) ✓; op-sqlite isolation/no-bundle (A2) ✓; session shim (A5) ✓; netinfo (A6) ✓; camera incl. iOS ZXing (B1) ✓; keyboard-wedge (B2) ✓; WebHID/WebUSB desktop-only (B3) ✓; geolocation/biometric/media/notifications/print (C1–C4) ✓; PWA install + offline (D1) ✓; nginx + Unraid + CORS, no COOP/COEP (D2,D3) ✓; reuse PIN→JWT + /sync (A5,D3) ✓; offline-first persistence + flush hooks + in-memory fallback (A4) ✓.
- **Placeholder scan:** the "read the native file first" steps (A5, A6, C1–C4) are concrete greps/reads needed to mirror exact signatures, not vague TODOs; HID usage-mapping caveat is documented with the keyboard-wedge fallback.
- **Type consistency:** `SqlDb` defined in A1 and used by A2/A4; `getDb/initDb/resetLocalDb/rowsAs/toBindable/bindParams` in A4 match `schema.ts` names exactly; persistence fns `loadDbSnapshot/saveDbSnapshot/clearDbSnapshot` defined in A3 and consumed in A4; `BarcodeScanner` props match native.
- **Phasing:** A is independently usable (offline-first web that logs in and syncs); B/C/D each add a usable capability.
