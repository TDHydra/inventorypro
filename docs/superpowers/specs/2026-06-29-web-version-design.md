# InventoryPro Web Version — Design Spec

**Date:** 2026-06-29
**Status:** Approved design (proceeding to plan)
**App:** InventoryPro (`apps/mobile`, Expo SDK 56) + API (`apps/api`, Fastify/Postgres)

## Problem

InventoryPro is an offline-first Expo React Native app. There is no web build. The team
wants the *same* app available in a browser — phone browsers (incl. iPhone Safari), iPads, and
desktops — so crews and office staff can use it without installing the native app, including
camera barcode scanning and USB/Bluetooth scanner support.

The only hard blocker is the data layer: every query uses op-sqlite's **synchronous**
`getDb().executeSync(...)` (219 call sites across 12 query modules + 21 migrations), and
op-sqlite is native-only with no web build. Everything else (sync engine, business logic, most
UI) is portable or has a clean web fallback.

## Goals

- Ship a web build from the **same codebase** (`apps/mobile`) via Expo Web / react-native-web.
- Preserve **offline-first** behavior on web (local DB + outbox/pull sync), mirroring native.
- Keep the synchronous data layer **unchanged** (no rewrite of the 219 call sites) by backing
  web with a synchronous `sql.js` (WASM) database persisted to IndexedDB.
- Support scanning on web: **camera** (incl. iOS Safari), **keyboard-wedge USB/Bluetooth** HID
  scanners, and **WebHID/WebUSB** scanners (desktop Chrome/Edge only).
- Install as a **PWA** and self-host on the Unraid box beside the API, reusing PIN→JWT auth and
  the existing `/sync` endpoints.

## Non-goals

- No rewrite into a separate web app or framework (no Next.js/Vite). One codebase.
- No change to the API, sync protocol, or activity-log rules.
- No change to native behavior — native keeps op-sqlite, expo-camera, expo-secure-store, etc.
- WebHID/WebUSB is desktop-Chrome/Edge-only by browser limitation; not delivered for iOS/Safari.

## Key technical correction (rationale)

A prior assessment claimed web SQLite is "fundamentally async," implying a rewrite of all 219
call sites. That conflated `sql.js` with OPFS/`wa-sqlite`. **`sql.js` is synchronous** — SQLite
compiled to WASM; `db.exec`/`db.run` return synchronously. Only the one-time WASM load is async
(and `initDb()` is already async). It runs on the main thread and needs **no
COOP/COEP/SharedArrayBuffer headers**. Therefore a `sql.js`-backed `getDb()` that exposes the
same `executeSync` keeps the entire query/migration/sync layer intact. This is what makes the
same-codebase approach feasible and is the basis of this design.

---

## Architecture

Add a **web target** to `apps/mobile`. Native-only leaf modules are replaced per-platform using
Metro's platform-extension resolution (`foo.web.ts(x)` wins on web; base `foo.ts(x)` is used on
native). Shared screens, query modules, and the sync engine are **untouched**.

```
apps/mobile/
  src/db/schema.ts          ← native: op-sqlite (unchanged)
  src/db/schema.web.ts      ← NEW web: sql.js synchronous shim + IndexedDB persistence
  src/components/BarcodeScanner.tsx       ← native (unchanged)
  src/components/BarcodeScanner.web.tsx   ← NEW web camera scanner (BarcodeDetector + ZXing)
  src/scan/hidScanner.web.ts              ← NEW WebHID/WebUSB (desktop Chrome/Edge)
  src/auth/session.ts        ← native: expo-secure-store
  src/auth/session.web.ts    ← NEW web: IndexedDB token store
  src/auth/biometric.web.ts  ← NEW web: WebAuthn-or-PIN
  ... (other .web shims: location, media, netinfo, notifications, print)
  web/                       ← NEW PWA assets (manifest, service worker, sql.js wasm)
  deploy/web/                ← NEW nginx Dockerfile + compose for Unraid
```

Build output: `expo export -p web` → static bundle → nginx container on Unraid.

---

## Components

### 1. Web bundling
- Add deps: `react-native-web`, `react-dom` (matched to the installed React 19), `sql.js`,
  `@zxing/browser` (iOS camera fallback). Dev deps: `@types/react-dom`, `@types/sql.js`.
- `app.json` `web.bundler` = `metro` (already declared). Confirm `expo export -p web` succeeds.
- Ensure native-only imports are isolated behind `.web` shims / `Platform` guards so Metro web
  never bundles op-sqlite, expo-camera, expo-secure-store, expo-local-authentication.

### 2. Synchronous DB shim — `src/db/schema.web.ts`
- Exposes the **same surface** the rest of the app imports from `./schema`: `initDb()`,
  `getDb()`, `rowsAs`, `bindParams`, and the migration runner — but backed by sql.js.
- `getDb()` returns an object with a synchronous `executeSync(sql, params?)` returning
  `{ rows: ... }` shaped exactly like op-sqlite's result so `rowsAs` and all call sites are
  unchanged.
- `initDb()` (already async): `initSqlJs({ locateFile })` → load persisted DB from IndexedDB
  (a single key holding the exported `Uint8Array`) into a new `SQL.Database(bytes)` → run
  migrations synchronously (the existing `runMigrations` logic, unchanged) → set the module db.
- **Persistence:** after writes, snapshot `db.export()` to IndexedDB, **debounced** (~500ms),
  and **flushed synchronously-ish** on `visibilitychange`/`pagehide`. A small `markDirty()` hook
  is called by `executeSync` for mutating statements.
- **Fallbacks:** sql.js WASM load failure → blocking error screen with retry (mirrors native
  DB-init failure). IndexedDB unavailable / private mode → in-memory DB + a persistent
  "changes won't be saved" banner.

### 3. Camera scanner — `src/components/BarcodeScanner.web.tsx`
- Same props `{ active, onScanned, onClose }`.
- `getUserMedia({ video: { facingMode: 'environment' } })` preview.
- Detection: use `BarcodeDetector` when `'BarcodeDetector' in window` (Android Chrome);
  otherwise **`@zxing/browser`** decoding from the video stream (iOS Safari, Firefox).
- Same debounce semantics as native (ignore duplicate code within ~1.5s). Torch toggle when
  the track supports it; otherwise hidden.

### 4. Hardware scanners
- **Keyboard-wedge USB/Bluetooth:** the existing `USBScanner` (hidden input capturing
  newline) already works on web — no change. It is the cross-browser path (incl. iPad/iOS).
- **`src/scan/hidScanner.web.ts`:** feature-detected WebHID (`navigator.hid`) / WebUSB connect
  behind an explicit "Connect scanner" button; emits decoded codes through the same
  `onScanned` contract. Desktop Chrome/Edge only; the button is absent when unsupported.

### 5. Other `.web` shims (same exported API as native)
- `src/auth/session.web.ts` — token store in IndexedDB (optionally WebCrypto-encrypted);
  same `saveSession/getValidJwt/clearSession` signatures.
- `src/auth/biometric.web.ts` — WebAuthn platform authenticator if available; else resolves to
  the PIN re-entry path.
- Location (`expo-location` usage in `useCurrentPosition`) — `navigator.geolocation` shim.
- Media (`MediaGallery`, expo-image-picker/file-system) — `<input type=file>` + File/Blob,
  upload via the API; preview via object URLs.
- NetInfo (`sync/engine`) — `navigator.onLine` + `online`/`offline` events.
- Notifications — Web Notifications API.
- Print/labels (`expo-print`) — `window.print()` / generated PDF.
- Maps/webview — already web-capable (iframe / Leaflet).

### 6. PWA + deploy
- `web/manifest.json` (name, icons, display: standalone) + a service worker caching the app
  shell and the sql.js `.wasm` so it installs and cold-boots offline on iPhone/iPad/desktop.
- `deploy/web/` — nginx Dockerfile serving the `expo export -p web` output + a
  `docker-compose` service for the Unraid stack alongside the API. No special COOP/COEP headers
  required (sql.js does not need SharedArrayBuffer). SPA fallback to `index.html`.
- Auth/CORS: served same-origin-ish with the API or with API CORS allowing the web origin;
  reuse PIN→JWT and `/sync/pull` + `/sync/push`.

---

## Data flow (web)

```
boot → initDb() [web]:
   initSqlJs(wasm) → load IndexedDB snapshot → new SQL.Database(bytes)
   → runMigrations() (sync, unchanged) → set module db
getDb().executeSync(...)  // all query modules unchanged
   mutating stmt → markDirty() → debounced snapshot → IndexedDB
sync engine (unchanged): fetch /sync/pull|push; NetInfo→navigator.onLine
auth: PIN→JWT via API; tokens in IndexedDB (session.web)
```

## Error handling
- WASM load failure → blocking retry screen.
- IndexedDB blocked/private mode → in-memory fallback + banner.
- Camera denied/unsupported → fall back to keyboard-wedge / manual entry; clear messaging.
- WebHID/WebUSB unsupported → button hidden; keyboard-wedge remains.
- Persistence: debounce writes; flush on `pagehide` to avoid data loss; snapshot is the whole
  DB file (data size here is a few MB — acceptable).

## Testing / verification
- `tsc --noEmit` clean for the project including the new `.web` files.
- `expo export -p web` builds without bundling native-only modules.
- Manual matrix: Chrome desktop, iPad Safari, iPhone Safari — login, offline boot (airplane
  mode after first load via SW), DB persists across reloads, sync round-trip when online.
- Camera scan: Android Chrome (BarcodeDetector) + iOS Safari (ZXing). Keyboard-wedge scan on
  desktop/iPad. WebHID scan on desktop Chrome.
- Deploy container to Unraid; verify served + reaches the API; PWA install on iOS/desktop.

## Phasing (each phase is independently usable)
- **Phase A — Runs offline-first:** web bundling (react-native-web/react-dom), `schema.web.ts`
  (sql.js + IndexedDB), `session.web`, NetInfo shim. Outcome: log in, browse, sync, offline.
- **Phase B — Scanning:** `BarcodeScanner.web.tsx` (BarcodeDetector + ZXing), keyboard-wedge
  validation, `hidScanner.web.ts` (WebHID/WebUSB).
- **Phase C — Remaining shims:** media, location, biometric, notifications, print.
- **Phase D — PWA + deploy:** manifest + service worker, nginx container, Unraid compose.

## Resolved decisions (2026-06-29)
- Same codebase (Expo Web), not a separate app.
- Full offline-first on web (sql.js + IndexedDB).
- Scanners: camera + keyboard-wedge + WebHID/WebUSB (last is desktop-Chrome/Edge-only).
- Self-hosted on Unraid (nginx container) beside the API; reuse PIN→JWT + `/sync`.

## Open items to confirm during planning
- Exact `react-native-web`/`react-dom` versions compatible with React 19.2 + RN 0.85 under
  Expo SDK 56 (pin during Phase A).
- Whether any third-party native RN libs (e.g. `react-native-webview`) need a `.web` alias or
  already ship web support under react-native-web.
- Service-worker strategy (Workbox vs hand-rolled) — decide in Phase D.
