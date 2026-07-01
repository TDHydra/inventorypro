---
name: debug
description: Diagnose and fix InventoryPro problems across the whole stack — on-device app crashes/blank screens, build failures (gradle/pnpm/expo/docker), API/server 500s, database state, and the recurring sync/outbox issues ("sync isn't working", stuck pending, changes not showing on other devices, "perms not updating"). Use whenever something is broken, misbehaving, or "not working" in InventoryPro and it's not obvious where the problem is — start here to triage before guessing.
---

# Debug InventoryPro

Offline-first Expo app (`apps/mobile`, op-sqlite) + Fastify/Postgres API (`apps/api`) syncing via an outbox→push / pull loop. Most "it's broken" reports fall into one of the sections below. **Triage first**, then jump to the matching section. Pair with `systematic-debugging` for anything non-obvious (reproduce → find root cause → fix the cause, not the symptom).

## Triage — where does it hurt?
- **App crashes / blank / behaves wrong on device** → §1 Runtime
- **Build/install won't complete** (gradle, pnpm, expo, docker) → §2 Build
- **"Sync isn't working" / pending stuck / change didn't reach other devices / a column is always null** → §3 Sync (the usual suspect)
- **Setting/permission/flag change doesn't show up** → §4 Reactivity (often mistaken for sync)
- **API returns 500 / a route misbehaves / need to see prod data** → §5 Server + DB

## §1 Runtime (on device)
- Fast loop is the **debug dev-client + Metro** (see `deploy-android` §B). Hotload, then read JS errors: `adb logcat -d ReactNativeJS:E AndroidRuntime:E '*:S'` or the on-device red box.
- **Release APKs do NOT emit `console.*` to logcat** — you get native crashes only. To trace logic in a release build, use the **server** side (push conflicts, activity log) or reinstall the dev-client.
- `pm clear` / uninstall wipes the saved Metro URL and local DB → the app re-syncs from prod on next login (first-launch full download).
- Dev-client won't connect: confirm `adb reverse tcp:8081 tcp:8081`, Metro is up (`curl localhost:8081/status` → `packager-status:running`), the screen is awake (`adb shell input keyevent KEYCODE_WAKEUP`), and relaunch via the deep link `exp+inventorypro://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081`. Kill stray Metros **by PID/port** (`lsof -ti tcp:8081`) — never `pkill -f "expo start"` (it matches its own command line and kills the shell).

## §2 Build
- **Gradle pinned to 8.13** (`android/gradle/wrapper/gradle-wrapper.properties`); `expo prebuild --clean` resets it → re-pin.
- **pnpm only.** Docker/API builds use `--frozen-lockfile`; if it fails, the lockfile is out of sync — `pnpm --filter <pkg> add <x>` or `pnpm install`, then confirm "Lockfile is up to date". Web docker build needs `babel-preset-expo` as a direct dep.
- **`@fastify/helmet` v11** for Fastify v4 (v13 is for v5 and breaks the build/boot).
- **Git worktrees have no `node_modules`** (pnpm symlinks aren't checked out) — don't run parallel builds/agents in fresh worktrees expecting deps; work in the main tree.
- Node 20 `node --test` doesn't expand globs — the api `test` script uses `find`. Capture full logs (don't `| tail` and lose the real error).

## §3 Sync / outbox  ← the recurring one
**Model:** device queues `appendOutbox(op, table, payload)` → `POST /sync/push` (`drainOutbox`); `GET /sync/pull` applies server rows via `pull.ts`. Server is authoritative.

Checklist when "sync isn't working":
1. **Stuck/pending outbox** — `getOutboxCounts()` splits `active` (still retrying) vs `failed` (attempts ≥ 5, dropped from retry but still counted → looks "stuck forever"). Tap the sync dot → **Retry**, or inspect `last_error`. A dead entry needs its root cause fixed, not just retried.
2. **Column always null / silently dropped after a migration** — the #1 footgun. Adding a synced column means all of: API migration + mobile migration (register in **`schema.ts` AND `schema.web.ts`**) + `pull.ts` `TABLE_UPSERT_SQL` (one more column) + its `rowToValues` case (one more value) with **column count == placeholder count**, + the `sync.ts` push path (`ALLOWED_TABLES`, `selectColumnsFor`, and `SENSITIVE_DENY`/`applyWritePolicy` if privileged). A mismatch drops the column with no error (burned migrations 008/009). Verify parity: count columns vs `?` in the table's `TABLE_UPSERT_SQL`. Full checklist: `docs/SYNC-MIGRATION-CHECKLIST.md`.
3. **A specific write is rejected every push** (permanent conflict) — server threw. Common causes: `activity_log.action`/`entity_type` not in the enum (`ACTIVITY_ACTIONS`/`ACTIVITY_ENTITY_TYPES` in `apps/api/src/lib/syncPolicy.ts`) → "Invalid activity_log action/entity_type"; a `Forbidden columns:` rejection (writing a `SENSITIVE_DENY` column like `users.role` without the perm); a `logging a UUID column with a string key` ("invalid input syntax for type uuid" — `activity_log.entity_id` etc. are UUID; use `note`/`metadata`, set entity_id null). Read the reason in the server logs (below) — the client only keeps it locally.
4. **Absolute-set didn't propagate** — a `stock_by_location` absolute value must be pushed as `INSERT` (server upserts via `ON CONFLICT`), not `UPDATE` (a plain UPDATE no-ops when the row doesn't exist yet). Deltas use `ADJUST`.
5. **updated_at / clock** — server forces `updated_at = NOW()` on generic upserts; incremental pull is `WHERE updated_at > since`. A row that "never pulls" usually means it wasn't actually written server-side (see 2–3), not a clock issue.

See the server-side reason: `docker logs inventorypro-api-1 --tail 200 | grep -i "conflict\|rejected\|denied"` (or `docker compose … logs api`).

## §4 Reactivity (not sync)
"Role perms / flags / config changed but the UI didn't update" is usually **not** a sync bug — it's a module cache that gates UI and didn't notify. These use `useSyncExternalStore` + a versioned module cache + listeners (`auth/permissions.ts` `loadRolePermissionCache`/`subscribeRolePermissions`, `hooks/usePermission.ts`). If a new synced-config read gates UI, it must notify subscribers (bump the version + fire listeners after pull) or it won't show until remount. Confirm the value actually changed in SQLite first (rule out sync), then check the cache/subscription wiring.

## §5 Server + DB (prod)
- **API logs:** `ssh root@192.168.1.239 'docker logs inventorypro-api-1 --tail 200'` (or `docker compose -f /mnt/user/appdata/inventorypro/docker-compose.prod.yml logs api`). The global error handler scrubs 5xx to `{error:'Internal Server Error'}` — the real stack/PG error is in these logs, not the response.
- **DB (Postgres is not host-exposed):** `ssh root@192.168.1.239 "docker exec inventorypro-postgres-1 psql -U inventorypro -d inventorypro -tAc \"<SQL>\""`. `activity_log` is append-only (Postgres RULES: UPDATE/DELETE no-op) — to clear it, TRUNCATE. `job_number` is the only sequence.
- **Permissions are DB-resolved**, never from the JWT role claim (`userHasPermission` in `apps/api/src/lib/permissions.ts`; keep in sync with `apps/mobile/src/constants/roles.ts`). A 403 that "should" be allowed → check `users.permission_overrides` + `role_settings.permission_overrides` for that role, and the `FULL_ADMIN_FLOOR`.
- **UDM/network access** to the box: if the API/DB is unreachable from your VLAN, pivot via unraid (`root@192.168.1.239`).

## Design / layout
Visual issues are best debugged live on the dev-client (§1). The design tokens are in `apps/mobile/src/theme.ts` (colors/spacing/radii/fontSizes); reuse the shared components (`AppInput`, `FilterChip`, `BulkActionBar`, `MediaGallery`, `SearchablePicker`) rather than ad-hoc styling so a fix stays consistent. Role-colored names resolve via `resolveRoleColor` (`constants/roles.ts`).
