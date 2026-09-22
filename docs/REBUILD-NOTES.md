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
| 2 mobile-v2 skeleton | in progress | 60ff9a3, 0399f3e |
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

## Verified so far (Phase 2 web round trip, 2026-09-22)

Fresh web client → roster → PIN login (bcrypt→JWT) → full download of all 37
tables (counts match prod dump) → theme write → outbox push (row landed in
dev PG) → pull watermark advanced. Denied bucket verified via the (since
removed) client login log.

## Unresolved / watch

- Device round-trip + hotload check pending (Phase 2 exit criterion).
- expo-notifications absent from dev variant — Wave D notification work must
  test against a release-variant or EAS dev build that includes it.
- Old app untouched and must stay runnable until Phase 10.
