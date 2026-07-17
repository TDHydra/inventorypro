# Reactive screens: #60 / #61 / #62 — design

**Date:** 2026-07-15
**Issues:** #60 (Jobs list never refreshes on sync), #61 (mount-only screens never react to sync), #62 (detail screens only refresh on refocus)
**Out of scope:** #63 `useDbQuery` and #64 per-table granularity — explicitly sequenced after these fixes (both issues carry the sequencing note); building the abstraction first would mean rewriting its call sites twice.

## Problem

Screens that read the local SQLite DB only update when *something* re-runs their query. The sync engine already broadcasts after every non-empty pull (`src/sync/pull.ts` → `bumpDataVersion()`), and most list screens subscribe via `useDataVersion()`. Three gaps remain:

1. **#60** — the Jobs list has *no* reactive path: `allJobs` and `myCheckouts` are keyed on a manual `reloadKey`, and `jobTypes` is a `useMemo(…, [])` frozen for the component's life. A job created on another device never appears.
2. **#61** — four mount-only sites query once and never again: dashboard low-stock (`useMemo(…, [])`), admin users (`useState(() => getAllUsers())`), manage-types (7 `useState(() => getTaxonomyTypes(…))` initializers), teams/[id] (focus-only re-read).
3. **#62** — seven screens use `useFocusRefresh()` (a focus-only counter) as their refresh key, so they update on refocus but never while open.

## Design

### 1. New hook: `useFocusOrDataRefresh()` — replaces `useFocusRefresh()`

`src/hooks/useFocusOrDataRefresh.ts`. Composes the two existing signals — **no new store** (per #62's instruction; reuses `src/sync/dataVersion.ts`):

```ts
export function useFocusOrDataRefresh(): number {
  const dataVersion = useDataVersion();
  const [focusKey, setFocusKey] = useState(0);
  useFocusEffect(useCallback(() => { setFocusKey(k => k + 1); }, []));
  // Both counters only increment, so the sum changes on either event.
  return focusKey + dataVersion;
}
```

JSDoc positions it as *the* refresh key for any screen that reads the DB. **`src/hooks/useFocusRefresh.ts` is deleted** so the stale-by-default hook can't be picked up by the next screen. All 9 importers migrate:

- Simple import + call swap (7): `(inventory)/[id].tsx`, `(jobs)/[id].tsx`, `(locations)/[id].tsx`, `(checkin)/index.tsx`, `(checkout)/index.tsx`, `(admin)/settings.tsx`, `(admin)/broadcast.tsx`.
- Swap + drop the now-redundant separate `useDataVersion()` **where it exists solely as a second refresh key** (2): `(equipment)/index.tsx`, `(inventory)/index.tsx`. If either screen uses `dataVersion` for anything beyond dep-keying alongside `refreshKey`, keep whatever is still needed — no behavior change beyond gaining the missing signal.

### 2. #60 — Jobs list (`app/(app)/(jobs)/index.tsx`)

Add `const dataVersion = useDataVersion();` and key the three DB reads on it:

- `allJobs` memo: deps gain `dataVersion` (keeps `reloadKey` — local mutations still bump it for instant feedback).
- `myCheckouts` memo: same (it reads active checkouts and is equally stale today).
- `jobTypes` memo: `[]` → `[dataVersion]` — new job types from another device appear.

### 3. #61 — mount-only screens

Same pattern as `(locations)/index.tsx:46-52` (a `dataVersion`-keyed `useEffect` that re-reads into state), because these hold query results in `useState`:

- **Dashboard** (`(dashboard)/index.tsx:37`): `useMemo(() => getLowStockItems(), [])` → `[dataVersion]`. (Memo, not state — one-line dep fix.)
- **Admin users** (`(admin)/users.tsx:170`): add `useEffect(() => { setUsers(getAllUsers()); }, [dataVersion])`. The edit sheet holds its own `editUser` object, so a background re-read can't clobber an in-progress edit.
- **Manage types** (`(admin)/manage-types.tsx:331-352`): one `useEffect` keyed on `dataVersion` re-reads all seven taxonomy lists. **Guarded by the existing `dragging` state**: skip the re-read while a drag-reorder is in flight so a sync pull can't yank rows out from under the gesture; the list catches up on the next bump (or next focus/remount).
- **Team detail** (`(teams)/[id].tsx:48-52`): the focus-effect re-read of `team` + `members` also re-runs on `dataVersion` (via `useFocusOrDataRefresh()` keying a `useEffect`, replacing the raw `useFocusEffect` wiring).

### 4. What does NOT change

- `src/sync/dataVersion.ts` and `src/sync/pull.ts` — the broadcast side already works; no sync-engine changes.
- No new store, no `useDbQuery` abstraction (that's #63), no per-table filtering (that's #64).
- Web build shares all of this code; no web-specific work.

## Error handling

These are synchronous local SQLite reads that already run at mount with no error handling; re-running them on a counter bump introduces no new failure mode. The `dragging` guard is the only interaction hazard identified.

## Testing & verification

1. **Unit:** `useFocusOrDataRefresh` depends on `expo-router`'s `useFocusEffect`, so it isn't unit-testable without a renderer harness the repo doesn't have; the underlying store (`dataVersion.ts`) is trivial and already exercised. No new unit tests; `tsc` + existing suites (mobile 132, API 210) must stay green.
2. **On-device (the real proof), per screen class:** with the dev client open on a screen, inject a row change directly into prod Postgres (simulating another device's write — same delivery path as a real one), wait for the next sync pull, and confirm the open screen updates **without navigation**:
   - Jobs list: INSERT a test job → appears; UPDATE a taxonomy `job` type label → picker updates (#60).
   - Dashboard low-stock, admin users, manage-types: UPDATE/INSERT a covered row → visible live (#61).
   - One `useFocusOrDataRefresh` screen (e.g. jobs/[id] with the test job open): UPDATE the row → detail updates while focused (#62).
   - Test rows deleted from prod afterwards.
3. **Hotload** the dev client per CLAUDE.md after the phase lands.

## Rollout

Client-only change: ships to the phone via Metro hotload now, to the field via the next release APK build, to the web on the next web image build. No API deploy, no migration.
