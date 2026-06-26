# /inv-sync-debug — Diagnose Sync Problems

Use this skill when data isn't syncing between the app and server, or when you see the yellow/red sync indicator and it won't clear.

## Quick checks

### 1. How many entries are stuck in the outbox?

Run in Metro debug console or via a temporary debug screen:
```typescript
import { getDb } from './src/db/schema';
const db = getDb();
const result = db.execute(`
  SELECT COUNT(*) as total,
         SUM(CASE WHEN attempts > 0 THEN 1 ELSE 0 END) as retried,
         MIN(created_at) as oldest,
         MAX(attempts) as max_attempts
  FROM outbox
  WHERE synced_at IS NULL
`);
console.log(result.rows._array[0]);
```

### 2. What error is the outbox hitting?

```typescript
const stuck = db.execute(`
  SELECT table_name, operation, attempts, last_error, created_at
  FROM outbox
  WHERE synced_at IS NULL AND attempts > 0
  ORDER BY attempts DESC
  LIMIT 10
`);
console.log(JSON.stringify(stuck.rows._array, null, 2));
```

Common `last_error` values and fixes:

| Error | Fix |
|---|---|
| `Network request failed` | Device is offline — wait for connection |
| `401 Unauthorized` | JWT expired — user must re-login; check token refresh in `src/auth/session.ts` |
| `403 Forbidden` | User lacks server-side permission for this operation |
| `409 Conflict` | Server rejected due to conflict — check conflict resolution in `src/sync/outbox.ts` |
| `422 Unprocessable` | Payload shape mismatch — check that SQLite schema and API schema match |
| `500 Internal` | Server error — check `docker compose logs api` |

### 3. Test API connectivity directly

```bash
# Replace with your API URL and a valid JWT
curl -H "Authorization: Bearer <jwt>" https://yourdomain.com/api/sync/pull?since=0
```
Should return JSON with table data. If it hangs or returns HTML → nginx is not proxying correctly.

### 4. Check last successful sync

```typescript
const settings = db.execute(`SELECT value FROM app_settings WHERE key = 'last_pulled_at'`);
console.log('Last pull:', settings.rows._array[0]?.value);
// If NULL → full download never completed
// If very old → device was offline for a long time, large pull coming
```

### 5. Force a manual sync

From the sync indicator sheet (tap the dot in the header), tap "Sync Now". This calls `syncEngine.triggerNow()` which:
1. Drains the outbox (push)
2. Pulls changes since `last_pulled_at`

If it still fails, check the Metro console for the error thrown by `src/sync/engine.ts`.

### 6. Replay a single failed outbox entry

```typescript
import { drainOutbox } from './src/sync/outbox';
// Force drain with verbose logging:
await drainOutbox({ verbose: true, limit: 1 });
```

### 7. Reset sync state (last resort)

Only do this if you're certain the server has the correct data:
```typescript
// Clears local DB and re-downloads everything
import { resetLocalDb } from './src/db/schema';
await resetLocalDb();
// App will show first-launch download screen on next open
```

## Server-side checks

```bash
# Check push route is receiving requests
docker compose -f infra/docker-compose.yml logs api | grep "POST /sync/push"

# Check for Postgres errors
docker compose -f infra/docker-compose.yml logs postgres | grep ERROR

# Check MinIO (if media upload is stuck)
docker compose -f infra/docker-compose.yml logs minio | tail -20
```

## Files involved

- `apps/mobile/src/sync/outbox.ts` — drain logic, retry, conflict resolution
- `apps/mobile/src/sync/pull.ts` — pull from server
- `apps/mobile/src/sync/engine.ts` — orchestrator, NetInfo listener
- `apps/api/src/routes/sync.ts` — push and pull API handlers
