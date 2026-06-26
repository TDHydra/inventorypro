# Location-aware UX — Implementation Plan (Parallel)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]`. **Verification gate:** no unit-test runner in this RN/Expo app — the gate per task is `npx tsc --noEmit` clean (controller runs it app-wide) + each task's manual/scratch check. The one pure unit (`proximity.ts`) gets a `npx tsx` scratch assertion. Implementer agents do **NO git and NO tsc**; the controller runs unified tsc, commits per task, reviews.

**Goal:** Use foreground device location to sort the nearest anchored location to the top of the source/current picker in Add Stock / Check Out / Check In (with a one-tap suggestion banner), capture location coordinates via "use my current spot", and stamp each move's coordinates onto its `activity_log` row.

**Architecture:** Additive migration 009 (coords on `locations`; lat/lng/accuracy on `activity_log`) + a pure proximity util + a foreground-only `expo-location` hook form the foundation; the location modals gain anchoring capture and the three move flows gain a proximity-sorted picker + banner + geo-stamp. Whole feature degrades to today's behavior when location permission is absent.

**Tech Stack:** Expo SDK 56, `@op-engineering/op-sqlite`, expo-router, `expo-location`, Fastify + Postgres.

## Global Constraints

- Expo SDK 56 — consult `https://docs.expo.dev/versions/v56.0.0/` before native/API code.
- op-sqlite bind params: only `string | number | null | ArrayBuffer`; coords are `number | null` (never `undefined`).
- `appendLog` self-enqueues its own `activity_log` outbox row — never separately outbox an activity_log row.
- **Additive migration only**, next version **009**; register in `loadMigrations()` (`apps/mobile/src/db/schema.ts`), version-ordered. Postgres mirror `apps/api/src/db/migrations/009_*.sql`.
- Sync: `locations` + `activity_log` already sync `SELECT *` → new columns flow automatically, **no sync code change**.
- **Graceful degradation is mandatory:** no permission / no reading → no sort, no banner, no stamp; behaves exactly as today; no crash, no nag loop.
- **Foreground-only, on-demand** location reads; never background, never continuous/watch.
- Full Shared Context Pack (field/signature tables) is in the spec: `docs/superpowers/specs/2026-06-26-location-aware-ux-design.md` — every task brief ships with it.

---

# WAVE 0 — FOUNDATION (tasks 1–3 have disjoint files; can run concurrently; merge before Wave 1)

## Task 1: Migration 009 + model extensions

**Files:**
- Create: `apps/mobile/src/db/migrations/009_location_coords.ts`
- Create: `apps/api/src/db/migrations/009_location_coords.sql`
- Modify: `apps/mobile/src/db/schema.ts` (register m009)
- Modify: `apps/mobile/src/db/queries/locations.ts` (`Location` + `upsertLocation`)
- Modify: `apps/mobile/src/db/queries/log.ts` (`LogEntry` + `appendLog`)

**Interfaces — Produces:**
- `Location` gains `latitude: number | null; longitude: number | null`.
- `LogEntry` gains `latitude: number | null; longitude: number | null; location_accuracy: number | null`.
- `appendLog` entry type gains **optional** `latitude?: number | null; longitude?: number | null; location_accuracy?: number | null` (coalesced to null) so the ~15 existing call sites are unaffected.

- [ ] **Step 1: op-sqlite migration 009.**
```ts
import { DB } from '@op-engineering/op-sqlite';
export const migration = {
  version: 9,
  up: (db: DB): void => {
    db.executeSync(`ALTER TABLE locations ADD COLUMN latitude REAL`);
    db.executeSync(`ALTER TABLE locations ADD COLUMN longitude REAL`);
    db.executeSync(`ALTER TABLE activity_log ADD COLUMN latitude REAL`);
    db.executeSync(`ALTER TABLE activity_log ADD COLUMN longitude REAL`);
    db.executeSync(`ALTER TABLE activity_log ADD COLUMN location_accuracy REAL`);
  },
};
```
- [ ] **Step 2: register m009** in `schema.ts` `loadMigrations()`: add
  `const { migration: m009 } = await import('./migrations/009_location_coords');` and include `m009` in the returned array.
- [ ] **Step 3: Postgres migration** `009_location_coords.sql`:
```sql
ALTER TABLE locations    ADD COLUMN IF NOT EXISTS latitude  DOUBLE PRECISION;
ALTER TABLE locations    ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS latitude  DOUBLE PRECISION;
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS location_accuracy DOUBLE PRECISION;
```
- [ ] **Step 4: extend `Location` + `upsertLocation`** in `locations.ts`. Add `latitude`/`longitude` (`number | null`) to the `Location` interface; in `upsertLocation` add both columns to the INSERT OR REPLACE column list + `bindParams` (default `loc.latitude ?? null`, `loc.longitude ?? null`). Read the existing function first; keep the full-upsert shape.
- [ ] **Step 5: extend `LogEntry` + `appendLog`** in `log.ts`. Add the 3 columns to `LogEntry`. In the `appendLog` entry param type add the 3 **optional** fields. Add the 3 columns to the INSERT statement + values (`entry.latitude ?? null`, etc.) and to the `appendOutbox('INSERT','activity_log', …)` payload (same coalesced values). Existing callers omit them → null.
- [ ] **Step 6 (controller): verify.** `cd apps/mobile && npx tsc --noEmit` clean; `cd apps/api && npx tsc --noEmit` clean. Fresh mobile DB logs `SQLite schema v9 ready`. API boot applies migration 9 (`schema_migrations` has 9).
- [ ] **Step 7 (controller): commit** `feat(db): migration 009 — location coords + activity_log geo-stamp columns`.

## Task 2: Proximity util (pure)

**Files:**
- Create: `apps/mobile/src/location/proximity.ts`

**Interfaces — Produces:**
- `interface LatLng { latitude: number; longitude: number }`
- `distanceMeters(a: LatLng, b: LatLng): number` (haversine)
- `sortByProximity<L extends { latitude: number | null; longitude: number | null }>(locations: L[], coords: LatLng | null): (L & { distanceM: number | null })[]`

- [ ] **Step 1: implement** `proximity.ts`:
```ts
export interface LatLng { latitude: number; longitude: number }

const R = 6371000; // earth radius, metres
const toRad = (d: number) => (d * Math.PI) / 180;

export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function sortByProximity<L extends { latitude: number | null; longitude: number | null }>(
  locations: L[],
  coords: LatLng | null,
): (L & { distanceM: number | null })[] {
  // Preserve original order; annotate distance; stable-sort anchored-by-distance, un-anchored last.
  const withIdx = locations.map((l, i) => {
    const anchored = coords && l.latitude != null && l.longitude != null;
    const distanceM = anchored
      ? distanceMeters(coords, { latitude: l.latitude as number, longitude: l.longitude as number })
      : null;
    return { l: { ...l, distanceM }, i, distanceM };
  });
  withIdx.sort((x, y) => {
    if (x.distanceM == null && y.distanceM == null) return x.i - y.i; // both un-anchored → original order
    if (x.distanceM == null) return 1;   // un-anchored sinks
    if (y.distanceM == null) return -1;
    return x.distanceM - y.distanceM || x.i - y.i;
  });
  return withIdx.map(w => w.l);
}
```
- [ ] **Step 2 (controller): verify** with a scratch assertion (pure module, no RN imports):
```bash
cd apps/mobile && npx tsx -e "
import { sortByProximity, distanceMeters } from './src/location/proximity';
const here = { latitude: 40.0, longitude: -75.0 };
const locs = [
  { id:'far', latitude:41.0, longitude:-75.0 },
  { id:'near', latitude:40.001, longitude:-75.0 },
  { id:'none', latitude:null, longitude:null },
];
const out = sortByProximity(locs, here);
if (out[0].id!=='near' || out[1].id!=='far' || out[2].id!=='none') throw new Error('order wrong: '+out.map(o=>o.id));
if (sortByProximity(locs, null).map(o=>o.id).join()!=='far,near,none') throw new Error('null-coords should keep input order');
console.log('proximity OK', Math.round(distanceMeters(here, {latitude:40.001,longitude:-75.0})),'m');
"
```
Expected: `proximity OK 111 m` (≈). (If `tsx` is unavailable, run the same logic via a compiled check; tsc must still pass.)
- [ ] **Step 3 (controller): commit** `feat(location): pure proximity util (haversine + sortByProximity)`.

## Task 3: expo-location + useCurrentPosition hook + permission config

**Files:**
- Create: `apps/mobile/src/hooks/useCurrentPosition.ts`
- Modify: `apps/mobile/app.json` (expo-location plugin + foreground usage strings)
- Modify: `apps/mobile/package.json` (controller installs `expo-location` via `npx expo install`)

**Interfaces — Produces:**
- `type PositionStatus = 'idle' | 'loading' | 'granted' | 'denied' | 'unavailable'`
- `useCurrentPosition(): { coords: { latitude: number; longitude: number; accuracy: number | null } | null; status: PositionStatus; request: () => Promise<void> }`

- [ ] **Step 1 (controller): install** `cd apps/mobile && npx expo install expo-location` (SDK-56-pinned). Implementers do not install.
- [ ] **Step 2: app.json** — add `"expo-location"` to `plugins` with a foreground rationale, e.g.
  `["expo-location", { "locationAlwaysAndWhenInUsePermission": false, "locationWhenInUsePermission": "Used only to suggest the nearest location while you're using the app — never tracked in the background." }]`.
  Ensure iOS `NSLocationWhenInUseUsageDescription` + Android foreground perms result (the plugin handles both). Do NOT request background permission.
- [ ] **Step 3: implement** `useCurrentPosition.ts` (read the Expo v56 docs for the exact API first):
```ts
import { useState, useCallback } from 'react';
import * as Location from 'expo-location';

export type PositionStatus = 'idle' | 'loading' | 'granted' | 'denied' | 'unavailable';
export interface Coords { latitude: number; longitude: number; accuracy: number | null }

export function useCurrentPosition() {
  const [coords, setCoords] = useState<Coords | null>(null);
  const [status, setStatus] = useState<PositionStatus>('idle');

  const request = useCallback(async () => {
    setStatus('loading');
    try {
      const { status: perm } = await Location.requestForegroundPermissionsAsync();
      if (perm !== 'granted') { setStatus('denied'); setCoords(null); return; }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setCoords({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy ?? null });
      setStatus('granted');
    } catch {
      setStatus('unavailable'); setCoords(null);   // no hardware / timeout → silent degrade
    }
  }, []);

  return { coords, status, request };
}
```
- [ ] **Step 4 (controller): verify** `cd apps/mobile && npx tsc --noEmit` clean (the hook compiles against the installed `expo-location` types). No device test here (covered when Wave 1 mounts it).
- [ ] **Step 5 (controller): commit** `feat(location): expo-location + foreground useCurrentPosition hook + permission config`.

---

# WAVE 1 — FEATURE (tasks 4–5; parallel; disjoint files)

## Task 4: Anchoring capture in location modals

**Files:** `app/(app)/(locations)/index.tsx`, `app/(app)/(locations)/[id].tsx`
**Consumes:** Task 1 (`Location.latitude/longitude`, `upsertLocation` writes them), Task 3 (`useCurrentPosition`).
- [ ] In the **create** modal (`index.tsx`) and the **edit** modal (`[id].tsx`), add latitude/longitude to the form state and a **"📍 Use my current spot"** button → calls `useCurrentPosition().request()`, and on `coords` sets the form lat/lng. Show an "Anchored ✓ · re-capture" state when set, and a quiet hint/“not anchored” when null; if permission is denied, show a one-line "Location permission off — you can still save without it." (no crash, no loop).
- [ ] Persist: include `latitude`/`longitude` in the `upsertLocation({...})` call and in the existing `appendOutbox('INSERT'|'UPDATE','locations', {...})` payload. Keep the existing `location_created`/`location_updated` `appendLog` calls unchanged (coords are on the row, not the log here).
- [ ] Verification: tsc clean; create/edit a location, tap "use my current spot" → lat/lng populate and persist (visible after reopen); saving without capture still works.

## Task 5: Proximity-sorted pickers + suggestion banner + geo-stamp (3 move flows)

**Files:** `src/components/LocationSuggestionBanner.tsx` (new), `app/(app)/(inventory)/add.tsx`, `app/(app)/(checkout)/index.tsx`, `app/(app)/(checkin)/index.tsx`
**Consumes:** Task 1 (`appendLog` coords fields), Task 2 (`sortByProximity`, `distanceMeters`), Task 3 (`useCurrentPosition`).
- [ ] New `LocationSuggestionBanner.tsx`: props `{ name: string | null; distanceM: number | null; onUse: () => void }`. Renders nothing when `name` is null; else a one-line "You're at **{name}** (~{Math.round(distanceM)} m) — use it" with a one-tap accept button calling `onUse`. Match existing banner/styling conventions.
- [ ] In each flow, for the **source/current** location picker (Add Stock: `locationOptions`; Check Out: source `selectedLocation` picker; Check In: return-to picker):
  - call `useCurrentPosition()`; on screen open, `request()` once (in a `useEffect`, fire-and-forget; never block the UI).
  - run the location list through `sortByProximity(locations, coords)`; build `PickerOption[]` in that order, putting a `~{m} m` hint in each anchored option's `sublabel`.
  - render `<LocationSuggestionBanner name={nearest?.name ?? null} distanceM={nearest?.distanceM ?? null} onUse={() => selectThatLocation()} />` above the picker, where `nearest` = first element with a non-null `distanceM`. Tapping selects it; nothing auto-commits.
- [ ] **Geo-stamp:** at each flow's move-confirm `appendLog({...})`, add `latitude: coords?.latitude ?? null, longitude: coords?.longitude ?? null, location_accuracy: coords?.accuracy ?? null`. (Every appendLog in these confirm paths — checkout_to_job/transfer/consumed, checkin, stocktake/add_stock — gets the stamp.)
- [ ] Verification: tsc clean; with a nearby anchored location, it ranks top of the source picker + banner shows; tapping selects it; confirming a move writes lat/lng/accuracy on the activity_log row; with permission denied everything still works unchanged.

---

# INTEGRATION / SHIP (controller, after Wave 1 merges)
- [ ] App-wide `npx tsc --noEmit` (mobile + api) clean; whole-branch review (opus) vs. spec.
- [ ] Merge `feat/location-aware-ux` → `main`.
- [ ] Deploy: rebuild API image + ship to Unraid → migration 009 applies on boot (verify `schema_migrations` has 9 + the new columns).
- [ ] **Dev-client rebuild** (new native module `expo-location`): `cd apps/mobile/android && ./gradlew installDebug` (debug dev client) so Metro testing works; the release APK rebuild (`assembleRelease`) for standalone use.

---

## Self-Review (controller checklist)
- **Spec coverage:** Unit1→T1; Unit2→T2; Unit3→T3; Unit4→T4; Unit5→T5; privacy/degradation threaded through T3 hook + T4/T5 null-guards; ship/dev-rebuild in Integration. ✔
- **Placeholder scan:** all code blocks are literal; the only "read first" notes (expo-location API, existing upsertLocation/appendLog) point at named files — not TBD.
- **Type consistency:** `Location.latitude/longitude` (T1) used by T2 generic + T4; `sortByProximity`/`distanceM` (T2) used by T5; `useCurrentPosition` `{coords:{latitude,longitude,accuracy}}` (T3) used by T4/T5; `appendLog` optional coords (T1) used by T5 stamping. Names match across tasks.
- **File-collision check:** T1 = db/query files; T2 = proximity.ts; T3 = hook+app.json+package.json; T4 = (locations) screens; T5 = move-flow screens + banner. All disjoint. ✔
