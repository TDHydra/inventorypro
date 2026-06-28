# P4 · 4a — GPS Anchor Input Modes — Design Spec

*Date: 2026-06-28 · Branch: `feat/p4a-gps-modes` · Program P4, build 1 (GPS modes; multi-parent deferred to 4b).*

## Context

Locations already store `latitude`/`longitude` (migration 009) and a location's create/edit forms can capture
the **current** GPS position (`useCurrentPosition` → `expo-location`). P4a adds the other two input modes from
the roadmap — **manual** entry and a **map** tap-to-set picker — and de-duplicates the anchor UI (currently
copied in both the create and edit screens).

### Decisions locked with the user
- **Scope:** GPS input modes only (manual + current + map). Multi-parent locations deferred to 4b.
- **Map picker:** Leaflet + OpenStreetMap rendered in a **WebView** (`react-native-webview`) — free, no Google
  account / API key / billing. Native dep → dev-client + APK rebuild. Map is **online-only** (tiles need
  network); manual + current modes cover offline.
- Build directly (not a multi-agent workflow); final opus adversarial review before merge.

## Global Constraints
- Expo SDK 56 (RN 0.85.3); op-sqlite binds `string|number|null|ArrayBuffer`. **No migration, no sync change,
  no API/prod deploy.** Native dep (`react-native-webview`) autolinks (settings.gradle has expo + community
  autolinking) → rebuild dev client + release APK.
- Read SDK-56 docs before coding (per `apps/mobile/AGENTS.md`). Install the SDK-compatible webview via
  `npx expo install react-native-webview` (pnpm-backed).
- Preserve maintenance guards (`isWriteBlocked()` / `disabled={locked}`) and existing outbox/`synced_at` conventions.

## Shared Context Pack
- **`useCurrentPosition` (`src/hooks/useCurrentPosition.ts`):** `{ coords: {latitude,longitude,accuracy}|null,
  status: 'idle'|'loading'|'granted'|'denied'|'unavailable', request() }`.
- **Create form (`app/(app)/(locations)/index.tsx`):** state `latitude/longitude` (`:51-52`), `useCurrentPosition`
  (`:54`), coords synced via effect (`:56-62`), saved into the location payload (`:132-133`); inline "GPS Anchor"
  block (`:321-343`) with the current-spot button + `anchorBtn`/`anchorHint` styles.
- **Edit form (`app/(app)/(locations)/[id].tsx`):** mirror — `editLatitude/editLongitude` (`:51-52`),
  `useCurrentPosition` (`:55`), populated from the row on edit (`:124`), saved (`:148-149`), inline anchor block (`:392+`).
- **UI primitives:** `ui/*` (AppInput/PrimaryButton/FieldLabel/ModalSheet), `theme.ts`. Both screens already
  use `useMaintenanceMode()`/`isWriteBlocked()`.

---

## Architecture (units)

### Unit 1 — Add `react-native-webview`
- `cd apps/mobile && npx expo install react-native-webview` (writes the SDK-compatible version to package.json +
  pnpm-lock). Autolinks on next native build — no plugin/app-config edit needed. No JS behavior change yet.
- Verify mobile `tsc --noEmit` clean.

### Unit 2 — `MapPickerModal` component
**File:** `apps/mobile/src/components/MapPickerModal.tsx`.
- Props: `{ visible: boolean; initial?: {latitude:number;longitude:number}|null; onPick(coords:{latitude:number;longitude:number}):void; onClose():void }`.
- Renders a full-screen `Modal` containing a `WebView` whose `source={{ html }}` is a self-contained Leaflet page:
  Leaflet CSS/JS from a CDN (unpkg), an OSM tile layer, a marker initialized at `initial` (or a default center
  when null), `map.on('click')` + marker `dragend` update the marker and stash the latest lat/lng; a "Use this
  location" button calls `window.ReactNativeWebView.postMessage(JSON.stringify({latitude,longitude}))`.
- RN side: `onMessage` parses the payload → `onPick(coords)` + `onClose()`. A "Cancel"/✕ closes without picking.
  `originWhitelist={['*']}`, `javaScriptEnabled`. Show a brief "needs internet" hint (tiles are network-loaded).
- Keep the HTML minimal and injected via a template string (escape coords as numbers, not string interpolation
  of untrusted data — coords are numbers).

### Unit 3 — `GpsAnchorField` shared component
**File:** `apps/mobile/src/components/GpsAnchorField.tsx`.
- Props: `{ value: {latitude:number;longitude:number}|null; onChange(v:{latitude:number;longitude:number}|null):void; disabled?: boolean }`.
- Three modes:
  - **Current:** a button using `useCurrentPosition` (mirrors the existing block, incl. denied/loading/unavailable states) → `onChange(coords)`.
  - **Manual:** two `AppInput`s (lat / lng, numeric keyboard) with range validation (lat −90..90, lng −180..180);
    valid edits call `onChange`. Pre-filled from `value`.
  - **Map:** a "📍 Pick on map" button → opens `MapPickerModal` (initial = `value` or current); on pick `onChange`.
- Displays the resolved coords (e.g. `12.3456, −65.4321`) + a "Clear" (→ `onChange(null)`). All controls respect `disabled`.

### Unit 4 — Wire into create + edit screens
**Files:** `app/(app)/(locations)/index.tsx`, `app/(app)/(locations)/[id].tsx`.
- Replace each inline "GPS Anchor" block (and its now-redundant `useCurrentPosition`/effect/anchor styles) with
  `<GpsAnchorField value={lat&&lng ? {latitude,longitude} : null} onChange={c => { setLat(c?.latitude ?? null); setLng(c?.longitude ?? null); }} disabled={locked} />`.
- Keep the saved payload (`latitude`/`longitude`) and all other create/edit behavior unchanged. Remove dead
  anchor styles/imports left behind.

---

## File map
| Unit | Files |
|---|---|
| 1 | `apps/mobile/package.json` (+ lockfile) |
| 2 | `apps/mobile/src/components/MapPickerModal.tsx` (new) |
| 3 | `apps/mobile/src/components/GpsAnchorField.tsx` (new) |
| 4 | `app/(app)/(locations)/index.tsx`, `app/(app)/(locations)/[id].tsx` |

## Verification
- `tsc --noEmit` clean (mobile). (api untouched.)
- Dev client rebuilt with `react-native-webview`; create + edit a location:
  - **Current** mode sets coords (existing behavior intact, incl. permission-denied path).
  - **Manual** mode accepts valid lat/lng, rejects out-of-range, round-trips into the saved row.
  - **Map** mode opens the Leaflet/OSM picker, tap/drag sets a pin, "Use this location" fills the field; the
    saved location has those coords.
  - "Clear" empties the anchor; maintenance lock disables all three modes.
- No duplicated anchor code remains (both screens use `GpsAnchorField`).
- Release APK rebuilt (includes react-native-webview + the new JS).

## Out of scope (4b + later)
- Multi-parent locations (join table + tree/picker/delete-rule rework) — separate sub-spec.
- Showing locations on a map / proximity sorting / map clustering.
- Offline map tiles (picker is online-only by design).
