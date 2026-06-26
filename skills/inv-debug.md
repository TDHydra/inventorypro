# /inv-debug — Diagnose InventoryPro Issues

Use this skill when something isn't working in the app: data not showing, permissions behaving wrong, sync stuck, crashes, etc.

## What to investigate

### 1. Check the outbox (sync stuck?)

On the device/emulator, run in the Metro debug console or via the seed script:
```sql
-- In the SQLite debug view or via inv-seed dev shell:
SELECT id, table_name, operation, attempts, last_error, created_at
FROM outbox
WHERE synced_at IS NULL
ORDER BY created_at ASC
LIMIT 20;
```
- `attempts > 3` with a `last_error` → the API is rejecting or unreachable
- `last_error` contains `401` → JWT expired, user needs to re-auth
- `last_error` contains `409` → conflict not being resolved, check `src/sync/outbox.ts` conflict handler

### 2. Check permission resolution

File: `apps/mobile/src/auth/permissions.ts`

Run `hasPermission(user, teamCtx, 'the_permission')` in the Metro console. Trace:
1. `ROLE_DEFAULTS[user.role]['the_permission']` — what does the base role grant?
2. `teamCtx?.team_permission_overrides['the_permission']` — any team override?
3. `user.permission_overrides['the_permission']` — any global override?

If a menu item is missing: `<PermissionGate permission="...">` in `apps/mobile/src/components/PermissionGate.tsx` is returning false. Add a temporary `console.log` inside `hasPermission` to trace the resolution.

### 3. Check SQLite schema vs expected

File: `apps/mobile/src/db/migrations/`

If the app crashes on startup with a SQLite error:
```bash
# Check which migration version the DB is on
# Look for: SELECT value FROM app_settings WHERE key = 'schema_version'
```
Compare to the highest migration number in `src/db/migrations/`. If mismatch → `inv-migrate` to apply pending migrations.

### 4. API connectivity

```bash
# From the VPS or local:
curl -X POST http://localhost:3000/auth/token \
  -H "Content-Type: application/json" \
  -d '{"user_id":"<uuid>","pin":"1234"}'
```
- `401` → wrong PIN or user inactive/expired
- `404` → user_id doesn't exist
- `500` → check API logs: `docker compose -f infra/docker-compose.yml logs api --tail=50`

### 5. Common issues checklist

| Symptom | First thing to check |
|---|---|
| White screen on launch | Metro bundler error — check terminal for red stack trace |
| Login rejected despite correct PIN | `users.active = false` or `expires_at` in the past |
| Items not showing after checkout | Outbox not draining — check network + `/inv-sync-debug` |
| Camera not opening | Missing `NSCameraUsageDescription` in app.json plugins section |
| USB scanner not capturing | `USBScanner` TextInput lost focus — check `onBlur` re-focus logic |
| Stock showing wrong numbers | `stock_by_location` out of sync — run a full pull: `GET /sync/pull?since=0` |
| Permission toggle not saving | `team_permission_overrides` JSONB merge failing — check PATCH /teams/:id/members/:uid |
| Media not uploading | MinIO unreachable — check `docker compose logs minio` and presigned URL expiry (15min) |

### 6. Logs

**API logs:**
```bash
docker compose -f infra/docker-compose.yml logs api -f
```

**Postgres query log** (enable in `.env`): set `POSTGRES_LOG_STATEMENT=all` temporarily.

**Activity log** (what actually happened):
```sql
SELECT u.name, al.action, al.entity_type, al.entity_id, al.created_at, al.metadata
FROM activity_log al
JOIN users u ON u.id = al.user_id
WHERE al.created_at > NOW() - INTERVAL '1 hour'
ORDER BY al.created_at DESC
LIMIT 50;
```

## Files most likely involved

- `apps/mobile/src/sync/outbox.ts` — sync failures
- `apps/mobile/src/auth/permissions.ts` — permission bugs
- `apps/mobile/src/db/migrations/` — schema issues
- `apps/api/src/routes/sync.ts` — push/pull errors
- `apps/api/src/plugins/auth.ts` — JWT issues
