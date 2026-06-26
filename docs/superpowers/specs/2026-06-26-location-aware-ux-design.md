# Location-aware UX — Design Spec

*Date: 2026-06-26 · Branch: `feat/location-aware-ux`*

## Context

The app's move flows (Add Stock, Check Out, Check In) pick a source/current location from a
`SearchablePicker` over `getAllLocations()`. This feature uses the device's **foreground**
physical location to (a) float the nearest anchored location to the **top** of that picker and
offer a one-tap suggestion banner, and (b) stamp the move's coordinates onto its `activity_log`
row for an audit trail of where each action physically happened. It builds on the existing
locations + picker flows — it only changes the *default ordering/suggestion* and adds an audit
stamp; it never auto-commits a selection.

### Decisions locked with the user
1. **Suggest, don't auto-commit** — nearest location surfaces (sorted to top + a one-tap banner); nothing is selected until the user taps.
2. **Stamp coordinates on each move** — `activity_log` records device `latitude`/`longitude`/`accuracy` per move (foreground-only, captured only when a move is performed).
3. **"Use my current spot" anchoring** — locations get coordinates by capturing the device position; no map dependency.
4. **Nearest sorts to the top of the picker** — the primary surfacing; robust to GPS drift (a slightly-off reading still ranks the right location near the top rather than auto-selecting wrong).

## Global Constraints (apply to every task)

- **Expo SDK 56** — consult `https://docs.expo.dev/versions/v56.0.0/` before native/API code.
- **op-sqlite bind params** accept only `string | number | null | ArrayBuffer`; booleans `0/1` locally, real booleans in outbox payloads. Coordinates are `REAL` (number) or `null`.
- **`appendLog(entry)`** self-enqueues its own `activity_log` outbox row — never separately outbox an activity_log row. Coordinates are added as new fields on the existing `appendLog` entry.
- **Additive migration only** — next version **009**: Postgres `ALTER` + op-sqlite `ALTER` + register in `loadMigrations()` (`apps/mobile/src/db/schema.ts`), version-ordered.
- **Sync:** `locations` and `activity_log` already sync `SELECT *` (push allowlist + pull) — new columns flow automatically, **no sync code change**.
- **Graceful degradation is mandatory:** with no location permission or no reading, every flow behaves exactly as today (no sort, no banner, no stamp). The feature is purely additive.
- **Foreground-only, on-demand:** never background tracking, never continuous polling. A position is read once when a move/anchor action needs it.
- New native module (`expo-location`) → requires a **dev-client debug rebuild** (not just a JS reload), like the recent `expo-file-system`/`expo-splash-screen` additions.

---

## Shared Context Pack (authoritative — from the codebase)

### Locations — `src/db/queries/locations.ts`
`Location{id,name,parent_id,color,icon,owner_user_id,active(0/1),updated_at,synced_at}` →
gains `latitude:number|null, longitude:number|null`. `getAllLocations()`, `getTopLevelLocations()`,
`getLocationTree()`, `upsertLocation(loc)` (full INSERT OR REPLACE — must include the 2 new columns).

### Logging — `src/db/queries/log.ts`
`appendLog(entry: Omit<LogEntry,'id'|'created_at'|'synced_at'>)` — fields include
user_id, team_id, action, entity_type, entity_id, from/to_location_id, quantity, unit, job_id,
note, metadata, device_id. **Adds** 3 **optional** entry fields `latitude?:number|null,
longitude?:number|null, location_accuracy?:number|null` — optional so the ~15 existing call sites
are unaffected; `appendLog` coalesces each to `null` (op-sqlite needs `null`, not `undefined`) when
writing the INSERT + outbox payload. `LogEntry` interface gains the 3 columns; the INSERT column
list + outbox payload always write all three (null when omitted). Only the move-flow confirms pass them.

### Move flows (each builds `PickerOption[]` from `getAllLocations()` + `SearchablePicker`)
- **Add Stock** — `app/(app)/(inventory)/add.tsx`: `locationOptions` (where stock is added = where you are).
- **Check Out** — `app/(app)/(checkout)/index.tsx`: `selectedLocation` source picker (coming from).
- **Check In** — `app/(app)/(checkin)/index.tsx`: return-to location picker(s).
`SearchablePicker` props take `options: PickerOption[]` where `PickerOption = {id, label, sublabel?}`.

### Migration shape (op-sqlite)
```ts
import { DB } from '@op-engineering/op-sqlite';
export const migration = { version: 9, up: (db: DB): void => {
  db.executeSync(`ALTER TABLE locations ADD COLUMN latitude REAL`);
  /* … */
}};
```
Postgres mirror = one `009_*.sql` (`ALTER TABLE … ADD COLUMN IF NOT EXISTS … DOUBLE PRECISION`).

---

## Architecture

### Unit 1 — Migration 009 (data model)
- `locations`: `latitude`, `longitude` (sqlite `REAL`, postgres `DOUBLE PRECISION`, nullable).
- `activity_log`: `latitude`, `longitude`, `location_accuracy` (same types, nullable).
- Register m009 in `loadMigrations()`. Update `Location` + `upsertLocation` and `LogEntry` + `appendLog` to carry the new columns (default null; partial-update safe).

### Unit 2 — Proximity util — `src/location/proximity.ts` (pure, no native)
- `distanceMeters(a:{latitude,longitude}, b:{latitude,longitude}): number` — haversine.
- `sortByProximity<L extends {latitude:number|null; longitude:number|null}>(locations: L[], coords|null): (L & {distanceM:number|null})[]` —
  anchored locations sorted nearest-first with `distanceM`; un-anchored locations keep their original
  relative order and sink to the bottom (`distanceM:null`). With `coords=null`, returns input order, all `distanceM:null`.
- Pure + unit-testable in isolation (no device needed).

### Unit 3 — Position hook — `src/hooks/useCurrentPosition.ts`
- Wraps `expo-location`: `requestForegroundPermissionsAsync()` then `getCurrentPositionAsync({accuracy: Balanced})`.
- Returns `{ coords: {latitude,longitude,accuracy}|null, status: 'idle'|'loading'|'granted'|'denied'|'unavailable', request: () => Promise<void> }`.
- Reads **once** on `request()` (or once on mount where a screen wants auto-read). Never polls/watches.
- Any failure (denied, timeout, no hardware) → `coords:null`, the caller degrades silently.

### Unit 4 — Anchoring capture (location create/edit modals)
- `(locations)/index.tsx` (create) + `(locations)/[id].tsx` (edit): a **"📍 Use my current spot"** button →
  `useCurrentPosition().request()` → set `latitude`/`longitude` on the form. Show "Anchored ✓ · re-capture" once set;
  persist via `upsertLocation` + the existing outbox UPDATE (now including lat/lng) + existing `location_created`/`location_updated` logs.
- No coordinates required; a location without them just never gets a `distanceM`.

### Unit 5 — Proximity in the move flows + stamping
- A small shared **`<LocationSuggestionBanner>`** (`src/components/LocationSuggestionBanner.tsx`): given the nearest
  anchored `{name, distanceM}` and an `onUse` callback, renders "You're at **{name}** (~{m} m) — use it" with a one-tap accept; renders nothing if no nearest/no permission.
- In each of the 3 flows: on the source/current picker, read position once (via the hook), run the location list through
  `sortByProximity`, map to `PickerOption[]` with a distance hint in `sublabel` (e.g. "~25 m"), and render the banner above the picker. Tapping the banner selects the nearest; the picker still works normally.
- On move confirm, pass the captured `coords` into `appendLog({ …, latitude, longitude, location_accuracy })` (null if none).

### Privacy / permission UX
- First time a location-using surface is hit, the OS permission prompt is preceded by a one-line rationale ("Used only to suggest the nearest location while you're using the app — never tracked in the background."). Declining is fully supported. `app.json` gets the `expo-location` plugin + the foreground usage description string (iOS `NSLocationWhenInUseUsageDescription`, Android fine/coarse foreground).

---

## File map

| Unit | Files |
|---|---|
| 1 | `apps/mobile/src/db/migrations/009_location_coords.ts` (new), `apps/api/src/db/migrations/009_location_coords.sql` (new), `schema.ts` (register), `queries/locations.ts` (Location+upsertLocation), `queries/log.ts` (LogEntry+appendLog) |
| 2 | `apps/mobile/src/location/proximity.ts` (new) |
| 3 | `apps/mobile/src/hooks/useCurrentPosition.ts` (new), `app.json` (expo-location plugin + usage strings), `package.json` (expo-location) |
| 4 | `app/(app)/(locations)/index.tsx`, `app/(app)/(locations)/[id].tsx` |
| 5 | `src/components/LocationSuggestionBanner.tsx` (new), `app/(app)/(inventory)/add.tsx`, `app/(app)/(checkout)/index.tsx`, `app/(app)/(checkin)/index.tsx` |

## Verification
- `tsc --noEmit` clean (mobile + api). Migration 009 applies on a fresh sqlite DB (schema v9) and Postgres.
- `proximity.ts` logic: nearest anchored location ranks first; un-anchored sink; `coords=null` → unchanged order. (Pure function — the one genuinely unit-testable unit; add a lightweight test if a runner is introduced, else assert via a scratch node check.)
- Manual: anchor "Warehouse" via "use my current spot"; open Check Out → Warehouse is top of the source picker with a distance hint + banner; tap banner selects it; confirm a move → `activity_log` row has lat/lng/accuracy.
- Permission denied path: every flow behaves exactly as today (no sort, no banner, no stamp) — no crash, no nag loop.

## Out of scope (backlog)
- Map pin picker / remote-location anchoring (chose capture-only).
- Geofence radius enforcement / auto-switching (suggest-only by design).
- Destination-location proximity (only source/current is sorted).
- Showing the stamped move coordinates on a map in the log views (data is captured; visualization later).
