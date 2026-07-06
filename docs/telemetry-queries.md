# Telemetry queries (v1)

Ready-to-run SQL against the server-only `telemetry_events` table
(`apps/api/src/db/migrations/029_telemetry_events.sql`). This table is never
synced to devices and is pruned at 90 days — these are point-in-time reports,
not a durable warehouse. No dashboard tool is wired up yet (Metabase etc. is
a deliberate follow-on); run these directly against Postgres in the meantime.

Columns: `id, session_id, user_id, device_id, platform, app_version, type
(screen|action|error|audit), name, screen, props (jsonb), client_ts,
received_at`.

## Top screens by views

```sql
SELECT name AS screen, COUNT(*) AS views
FROM telemetry_events
WHERE type = 'screen' AND received_at > NOW() - INTERVAL '7 days'
GROUP BY name
ORDER BY views DESC
LIMIT 25;
```

## Screen drop-off (last screen seen before a session went quiet)

A session's "last screen" is the most recent `screen` event per `session_id`
whose gap to the *next* event (if any) exceeds an idle threshold — or that has
no later event at all. This treats "last screen ever seen in the session" as
a proxy for "where they got stuck / left".

```sql
WITH last_screen AS (
  SELECT DISTINCT ON (session_id)
    session_id, name AS screen, received_at
  FROM telemetry_events
  WHERE type = 'screen' AND received_at > NOW() - INTERVAL '7 days'
  ORDER BY session_id, received_at DESC
)
SELECT screen, COUNT(*) AS sessions_ended_here
FROM last_screen
GROUP BY screen
ORDER BY sessions_ended_here DESC
LIMIT 25;
```

## Error rate by screen

```sql
SELECT
  COALESCE(e.screen, 'unknown') AS screen,
  COUNT(*) FILTER (WHERE e.type = 'error') AS errors,
  COUNT(*) FILTER (WHERE e.type = 'screen') AS views,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE e.type = 'error')
      / NULLIF(COUNT(*) FILTER (WHERE e.type = 'screen'), 0),
    2
  ) AS error_pct
FROM telemetry_events e
WHERE e.received_at > NOW() - INTERVAL '7 days'
GROUP BY 1
ORDER BY errors DESC
LIMIT 25;
```

## Most-tapped controls

```sql
SELECT name AS control, screen, COUNT(*) AS taps
FROM telemetry_events
WHERE type = 'action' AND received_at > NOW() - INTERVAL '7 days'
GROUP BY name, screen
ORDER BY taps DESC
LIMIT 25;
```

## Per-user activity

```sql
SELECT
  u.name AS user_name,
  COUNT(*) FILTER (WHERE e.type = 'screen') AS screen_views,
  COUNT(*) FILTER (WHERE e.type = 'action') AS taps,
  COUNT(*) FILTER (WHERE e.type = 'error')  AS errors,
  COUNT(*) FILTER (WHERE e.type = 'audit')  AS audit_events,
  MAX(e.received_at) AS last_seen
FROM telemetry_events e
JOIN users u ON u.id = e.user_id
WHERE e.received_at > NOW() - INTERVAL '7 days'
GROUP BY u.name
ORDER BY last_seen DESC;
```

## Dead-outbox counts by table

Sourced from the sync-friction `error`/`outbox_dead` events emitted by
`apps/mobile/src/sync/engine.ts` when a queued write exhausts its retry
attempts (`props.table`, `props.operation`, `props.attempts`).

```sql
SELECT
  props->>'table' AS table_name,
  props->>'operation' AS operation,
  COUNT(*) AS dead_count
FROM telemetry_events
WHERE type = 'error' AND name = 'outbox_dead'
  AND received_at > NOW() - INTERVAL '7 days'
GROUP BY 1, 2
ORDER BY dead_count DESC;
```

## Push conflicts by table + reason

```sql
SELECT
  props->>'table' AS table_name,
  props->>'reason' AS reason,
  COUNT(*) AS conflicts
FROM telemetry_events
WHERE type = 'error' AND name = 'push_conflict'
  AND received_at > NOW() - INTERVAL '7 days'
GROUP BY 1, 2
ORDER BY conflicts DESC;
```

## Audit activity by business table

```sql
SELECT
  name AS action,
  props->>'table' AS entity_table,
  COUNT(*) AS events
FROM telemetry_events
WHERE type = 'audit' AND received_at > NOW() - INTERVAL '7 days'
GROUP BY 1, 2
ORDER BY events DESC
LIMIT 50;
```

## Privacy spot-check

Run after any capture-layer change to confirm nothing PII-shaped is leaking
into `props` (should return zero rows — the allowlist in
`apps/api/src/lib/telemetry.ts` / `apps/mobile/src/telemetry/redact.ts`
should have already stripped these keys server- and client-side):

```sql
SELECT id, type, name, props
FROM telemetry_events
WHERE props::text ~* '"(pin|note|customerName|address|email|phone)"'
LIMIT 50;
```

## Kill-switch

`app_config.telemetry_enabled` gates capture *and* flush remotely (no
rebuild required):

```sql
-- Disable telemetry fleet-wide
UPDATE app_config SET value = '0', updated_at = NOW() WHERE key = 'telemetry_enabled';
-- Re-enable (absent row also means enabled — client/server both default to on)
INSERT INTO app_config (key, value) VALUES ('telemetry_enabled', '1')
ON CONFLICT (key) DO UPDATE SET value = '1', updated_at = NOW();
```

The write above goes through the existing `app_config` sync path (it's an
`ALLOWED_TABLES`/`FULL_TABLES` entry — see `apps/api/src/routes/sync.ts`), so
it reaches devices on their next pull like any other synced setting.
