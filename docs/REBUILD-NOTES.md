# Lean Rebuild — shared phase notes

Working notes for the mobile-v2/api-v2 rebuild (plan: 10 phases, branch
`lean-rebuild`). Kept current so parallel subagents can pick up context
without re-deriving it. Update the relevant section when your phase work
lands; reconcile, don't overwrite.

## Status

| Phase | State | Commits |
|---|---|---|
| 0 prep/guardrails | done | 661a93d |
| 1 packages/ui + core + manifest | done | 5231e49, 9a6b03f, 54828d0 |
| 2 mobile-v2 skeleton | done | 60ff9a3, 0399f3e |
| 3–10 | pending | — |

## Architecture facts (verified, don't re-derive)

- `packages/core` is platform-free: DB arrives via `setDbProvider(() => SqlDb)`,
  config via `configureCore({apiBase, generateUUID, auth, assertWritable?, track?})`.
  Config is read at call time — never capture it at module top.
- `SqlDb = {executeSync(sql, params?): {rows: any[]}; close()}`. op-sqlite's DB
  satisfies it directly; web wraps sql.js (`apps/mobile-v2/src/db/schema.web.ts`).
- ONE migrations index for both platforms:
  `apps/mobile-v2/src/db/migrations/index.ts`. Migration 001 = generated
  baseline from the manifest (`baselineDdl()`); `tableDdl` emits
  `CREATE TABLE/INDEX IF NOT EXISTS` because the runner bootstraps
  `app_settings` (schema_version watermark) before 001 runs.
- Sync triggers are injected: `startSyncEngine(appSyncTriggers)` — NetInfo +
  AppState in `src/sync/triggers.ts` (`netinfo.web.ts` shims navigator.onLine).
- Post-pull refreshers register via `registerAfterPull({name, tables?, run})`.
  Phase 2 registers only rolePermissions on `['role_settings']` (in `src/boot.ts`).
- `getOutboxCounts()` returns `{active, failed}`; denied entries are a separate
  bucket via `getDeniedOutbox()`.
- Root layout remounts the whole Stack on theme change (`key={theme.id}`) —
  navigation state resets to the index route when the theme switches. Known,
  accepted for now.

## Contract gotchas (cost real debugging time)

- **activity_log `login`/`pin_set` are serverOnly**: `/auth/token` writes the
  authoritative row; a client push of these actions is permanently denied
  (`NOT_ALLOWED`). v2's finishLogin therefore writes NO client login log — the
  old app's did and accumulated one denied outbox entry per login. Don't
  reintroduce it. Other appendLog actions push fine.
- `EXPO_PUBLIC_*` env vars inline at bundle time and Metro caches transforms:
  changing them requires `expo export --clear` (or `expo start -c`).
- expo serve of a web export has no SPA fallback — deep links 404; enter at `/`.
- PG enum columns are TEXT on mobile; never remap without ALTER-to-TEXT.
- bcrypt hashes (`$2b$...`) corrupt inside double-quoted shell strings.

## Dev environment (local, mirrors prod contract)

- PG: docker `invenpro-dev-pg`, postgres:16-alpine on 127.0.0.1:5433,
  user/db `invenpro`/`inventorypro`, pw `devlocal`; restored from
  `~/archive/InventoryPro-artifacts/prod-dump-2026-09-21.sql.gz`.
- API: old apps/api via tsx on **:3001** (NOT :3000 — stale root-owned Sep21
  processes hold :3000 with an old build; leave them). Env: DATABASE_URL to
  :5433, dev JWT secret, MINIO stub creds, CORS for localhost:8081/8082.
- Dev user: "Dev Tester", full_admin, PIN 4242,
  id `fca1237e-8397-4a91-8f01-26f2ca3fa3db` (dev DB only).
- Web smoke: `npx expo export --platform web --clear` then `npx expo serve dist`
  on :8081.
- Device dev build: `APP_VARIANT=development` → applicationId
  `com.inventorypro.app.v2`, name "InventoryPro Dev", no google-services /
  expo-notifications plugin (coexists with the prod app). Local build:
  `expo prebuild --platform android` + `./gradlew assembleDebug`.
  USB device + `adb reverse` lets the device use localhost URLs.

## Verified so far (Phase 2 exit, 2026-09-22)

Both targets green against the local dev API + prod-dump PG:

- **Web**: fresh client → roster → PIN login (bcrypt→JWT) → full download of
  all 37 tables (counts match prod dump) → theme write → outbox push (row
  landed in dev PG) → pull watermark advanced. Denied bucket verified via the
  (since removed) client login log.
- **Device** (Galaxy S24 Ultra, debug dev-client APK installed alongside the
  prod app): login → full download → live counts identical to web → theme
  writes push to PG within seconds → server-pulled user theme applies at
  login. Denied count 0 (finishLogin fix confirmed on-device).
- **Hotload**: metro fast refresh works, BUT metro must NOT be started with
  CI=1 — that silently disables file watching (no rebundle on edit). Start it
  under a pty (`script -qefc "... npx expo start --port 8082" /dev/null`) or
  a real terminal.
- Device networking: `adb reverse tcp:8082 tcp:8082` + `tcp:3001 tcp:3001`,
  launch dev client via
  `inventorypro://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8082`
  — an "Open with" chooser appears (prod app shares the scheme); pick
  "InventoryPro Dev".

## Wave A progress

Foundation landed (repos + shared components; screens next):

- `src/repos/`: items, search, suggestions, locations, rooms, taxonomy,
  equipment, equipmentUnits, maintenance, labelResolve, jobs (READ-ONLY stub
  for search/pickers — full jobs repo is Wave C), + testDb harness and tests.
  Repos self-mirror to the outbox; components/screens must NOT call
  `appendOutbox` after a repo write (double-write bug — already caught and
  fixed once). Legit direct appendOutbox callers: `src/db/{formMode,
  hiddenFields,mainStorage}.ts` (app_config, no repo) and one raw-SQL delete
  path in QuickAddEditSheet.
- `src/components/`: ItemCard, Barcode{Input,Scanner(+.web)}, USBScanner,
  SearchablePicker, TooltipHint, PermissionGate, QuickAddBanner,
  LocationSuggestionBanner, UnitRow, MoveStockModal, GpsAnchorField,
  MapDisplay/MapPickerModal/leafletAssets, CsvImport, pickers/ (whole dir),
  quickadd/ (shell + item/location/stock/equipment sheets + stockGates),
  ui/{AdvancedFields,AutofillTextField,HidableField} + their hooks/constants.
  SuggestInput/BulkActionBar/quickAddBanner-lib/typeColors NOT copied — they
  live in `@invenpro/ui`.
- TODO markers to honor in later waves: `TODO(wave-media)` (MediaThumbnail/
  Gallery cut from ItemCard/ItemQuickAdd), `TODO(wave-chat)` (PermissionGate
  request-access DM → toast), `TODO(wave-B)` (QuickCreateSheet vehicle/job/
  repair/team/user kinds return null; typed-route casts to unbuilt screens),
  `TODO(gap)` (queries/access.ts unit-inventory lock stubbed always-unlocked
  at 4 call sites — server enforcement unaffected; 381-ln module to port with
  the access surface in Wave B).
- Verified: `pnpm --filter mobile-v2 typecheck` clean; mobile-v2 unit tests
  40/40; `@invenpro/core` 181/181.
- A fork stray-edited `apps/mobile/src/components/BarcodeScanner.web.tsx`
  (syntax-breaking garbage) — reverted via git checkout; v2 copy verified
  clean. Old app is READ-ONLY: re-check `git status apps/mobile` after any
  subagent wave.

Screens landed (all six Wave A surfaces; typecheck clean, 40/40 + 181/181):

- Routes are PLAIN dirs under `app/(app)/` (no parens groups): `inventory/
  {index,[id],low-stock}`, `locations/{index,[id]}`, `equipment/{index,[id]}`,
  `manage-types`, `scan`, `checkout`, `quickadd/{index,[sheet]}`. Hub stub
  gained a 7-tile grid (real role hub is Wave D).
- checkout.tsx (1600 ln) absorbs the old checkin screen as a CheckinPanel
  mode; no checkouts table exists — state derives from activity_log/stock/
  units via existing repos. jobs.ts stays READ-ONLY (got ActiveCheckout +
  getActiveCheckoutsForUser).
- quickadd/[sheet] is ONE dynamic route for all kinds; wave-B/C kinds render
  disabled tiles / "coming soon". ItemQuickAdd reads a `barcode` param;
  StockQuickAdd reads a `locationId` param (added for locations' "+ Add Stock
  Here" — the old (inventory)/add.tsx was NOT ported, quickadd replaces it).
- equipment gained a model-wide Maintenance Timeline
  (getMaintenanceEventsForItem in repos/maintenance.ts) and a
  NewEquipmentModelSheet on index (gap: no sheet could create a kind:
  'equipment' model).
- locations detail's "rooms" = sub-areas via repos/locations.getRoomsForParent;
  repos/rooms.ts is the separate room-catalog table (photo tagging).
- Remaining intentional `as never` casts: ONLY the three `/(app)/repairs/new`
  pushes (ItemCard, equipment/[id], locations/[id]), tagged TODO(wave-C).
  Wave C MUST sweep them when repairs lands.
- `.expo/types/router.d.ts` (typed routes, gitignored) is regenerated ONLY by
  a real metro dev server run (`expo start`, pty, no CI=1) — `expo export`
  does NOT reliably regenerate it. If new routes throw TS2322 route-type
  errors, run metro briefly, then typecheck.

## Subagent strategy (user decision, 2026-09-22)

Wave A ran 6 parallel screen agents and hit the session rate limit mid-flight.
From Wave B onward: ONE persistent porting agent worked assembly-line style —
coordinator sends it one station (domain) at a time via follow-up messages so
its context/porting patterns carry forward; verify + commit per station before
feeding the next. No parallel fan-out for porting work.

## Unresolved / watch

- expo-notifications absent from dev variant — Wave D notification work must
  test against a release-variant or EAS dev build that includes it.
- Old app untouched and must stay runnable until Phase 10.
- The "VPS" (10.8.0.1) is a QEMU VM `Ubuntu26-InvenPro-VPS` on the Unraid box
  (192.168.1.239) — VM snapshots are an extra rollback lever for Phase 8.
