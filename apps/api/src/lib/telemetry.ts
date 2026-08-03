// Server-side telemetry event sanitizer. Mirrors the client's redactProps
// (apps/mobile/src/telemetry/redact.ts) — the two allowlists MUST stay
// identical, since a prop that's meaningless on one side but present on the
// other is a sign the contract has drifted.
const TYPES = new Set(['screen', 'action', 'error', 'audit']);

// Safe, non-PII prop keys. Names/ids/metrics only — never field contents.
export const TELEMETRY_PROP_ALLOWLIST = new Set([
  'itemId', 'unitId', 'locationId', 'jobId', 'teamId', 'repairId', 'userId',
  'count', 'qty', 'durationMs', 'ms', 'code', 'status', 'httpStatus', 'ok',
  'reason', 'table', 'operation', 'attempts', 'kind', 'mode', 'from', 'to', 'tab',
  // validation_reject metadata: the FIELD PATH and RULE NAME only — never the
  // entered value (which must not appear anywhere in telemetry).
  'field', 'rule',
  // outbox_heartbeat (#236): fleet sync-health counts — three independent
  // buckets, so 'count' alone can't carry them.
  'pending', 'failed', 'denied',
]);

export interface CleanEvent {
  type: string; name: string; screen: string | null;
  props: Record<string, unknown>; client_ts: string | null;
}

// name/screen are identifiers (route patterns, testIDs, action keys) — NOT free
// text. The props allowlist can't protect these fields, so this is their guard:
// drop control chars + collapse whitespace runs (a defense against a caller
// smuggling multi-word content), and hard-cap length. The primary defense is
// upstream (clients source these from route patterns / testIDs, never raw
// accessibility labels), but the server never trusts that.
export function sanitizeLabel(s: string, max = 120): string {
  return s.replace(/[\x00-\x1f\x7f]+/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export interface IngestContext {
  sessionId: string;
  userId: string | null;
  deviceId: string | null;
  platform: string | null;
  appVersion: string | null;
}

/**
 * The /telemetry route handler core, extracted so it's unit-testable with a
 * mock pg (the route itself just resolves auth/rate-limit/headers). Sanitizes
 * each raw event, inserts the survivors, and returns how many were accepted.
 * Fire-and-forget: a bad row is skipped and a failed INSERT never aborts the
 * batch — telemetry loss is acceptable, a failed business request is not.
 */
export async function ingestEvents(
  pg: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  rawEvents: unknown[],
  ctx: IngestContext,
): Promise<number> {
  let accepted = 0;
  for (const raw of rawEvents) {
    const e = sanitizeEvent(raw);
    if (!e) continue;
    try {
      await pg.query(
        `INSERT INTO telemetry_events (session_id,user_id,device_id,platform,app_version,type,name,screen,props,client_ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [ctx.sessionId, ctx.userId, ctx.deviceId, ctx.platform, ctx.appVersion, e.type, e.name, e.screen, JSON.stringify(e.props), e.client_ts],
      );
      accepted++;
    } catch { /* fire-and-forget: never fail the batch on one bad row */ }
  }
  return accepted;
}

export interface NameCount { name: string; count: number }
/** A single day's bucket in a time-series trend (day is a 'YYYY-MM-DD' key). */
export interface DayCount { day: string; count: number }
/** Per-user activity roll-up, resolved to a display name + role via users join. */
export interface UserActivity { userId: string; name: string; role: string; count: number }

export interface TelemetrySummary {
  windowDays: number;
  totals: { events: number; sessions: number; users: number; devices: number; errors: number };
  // Distinct-actor signals seen in the window. telemetry_events has no push-token
  // column, so "active actors" are the distinct identity keys it does carry:
  // authenticated users (user_id), devices (device_id), and sessions — plus how
  // many of those sessions were anonymous (pre-login funnel).
  active: { users: number; devices: number; sessions: number; anonSessions: number };
  topScreens: NameCount[];
  topActions: NameCount[];
  topErrors: NameCount[];
  errorTrend: DayCount[];         // error-event count bucketed by day, zero-filled
  byUser: UserActivity[];         // top-N authenticated users by event count
  byRole: NameCount[];            // event count grouped by users.role
  byTeam: NameCount[];            // event count grouped by team (team_members join)
  byPlatform: { platform: string; count: number }[];
  byVersion: { version: string; count: number }[];
}

/**
 * Pure zero-fill for the daily error trend. The DB only emits rows for days that
 * actually had errors; a trend chart needs a continuous axis, so this produces
 * exactly `days` consecutive UTC-day buckets ending on `now`'s UTC day, merging
 * the DB counts in and defaulting the gaps to 0. UTC-anchored to match Postgres'
 * default `date_trunc('day', …)` (prod runs UTC). Extracted so the shaping logic
 * is testable without a DB. Guards empty/undefined input — no throw, no NaN.
 */
export function zeroFillDailyTrend(
  rows: { day: string; count: number }[] | null | undefined,
  days: number,
  now: Date = new Date(),
): DayCount[] {
  const counts = new Map<string, number>();
  for (const r of rows ?? []) {
    if (r && typeof r.day === 'string') counts.set(r.day, (counts.get(r.day) ?? 0) + Number(r.count || 0));
  }
  const span = Math.max(1, Math.floor(days) || 1);
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out: DayCount[] = [];
  for (let i = span - 1; i >= 0; i--) {
    const key = new Date(base - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day: key, count: counts.get(key) ?? 0 });
  }
  return out;
}

/**
 * Pure shaping of the single summary row (see getTelemetrySummary's query) into
 * the wire model. Every list defaults to [] when its CTE produced no rows
 * (json_agg → NULL on an empty set) and every total defaults to 0, so an empty
 * window renders gracefully with no divide-by-zero downstream. Testable without
 * a DB.
 */
export function shapeTelemetrySummary(row: any, days: number, now: Date = new Date()): TelemetrySummary {
  const t = row?.totals ?? {};
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    windowDays: days,
    totals: {
      events: t.events ?? 0, sessions: t.sessions ?? 0, users: t.users ?? 0,
      devices: t.devices ?? 0, errors: t.errors ?? 0,
    },
    active: {
      users: t.users ?? 0, devices: t.devices ?? 0,
      sessions: t.sessions ?? 0, anonSessions: t.anon_sessions ?? 0,
    },
    topScreens: arr<NameCount>(row?.screens),
    topActions: arr<NameCount>(row?.actions),
    topErrors: arr<NameCount>(row?.errors),
    errorTrend: zeroFillDailyTrend(arr<DayCount>(row?.err_trend), days, now),
    byUser: arr<UserActivity>(row?.by_user),
    byRole: arr<NameCount>(row?.by_role),
    byTeam: arr<NameCount>(row?.by_team),
    byPlatform: arr<{ platform: string; count: number }>(row?.platforms),
    byVersion: arr<{ version: string; count: number }>(row?.versions),
  };
}

/**
 * Aggregate read model for the admin analytics screen (GET /telemetry/summary).
 * All counts are over the last `days` window (telemetry_events is pruned at 90d,
 * so callers clamp days to [1,90]). `days` is bound via make_interval — never
 * string-interpolated. Extracted from the route so it's unit-testable with a
 * mock pg. This is the ONLY read path into telemetry_events; it's gated on
 * system_settings at the route.
 *
 * ONE round-trip: a single CTE query slices the window once (`win`) and derives
 * every tile/list off it (totals, top-N screens/actions/errors, error trend,
 * per-user/role/team roll-ups, platform/version splits), each collapsed to a
 * json_agg column so the whole report comes back as a single row. Pure shaping
 * (defaults, zero-fill) is delegated to shapeTelemetrySummary.
 */
export async function getTelemetrySummary(
  pg: { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> },
  days: number,
): Promise<TelemetrySummary> {
  // $1 (days) is the only binding; every literal below is static SQL.
  const sql = `
    WITH win AS (
      SELECT * FROM telemetry_events
       WHERE received_at > NOW() - make_interval(days => $1)
    ),
    totals AS (
      SELECT COUNT(*)::int AS events,
             COUNT(DISTINCT session_id)::int AS sessions,
             COUNT(DISTINCT user_id)::int AS users,
             COUNT(DISTINCT device_id)::int AS devices,
             COUNT(*) FILTER (WHERE type = 'error')::int AS errors,
             COUNT(DISTINCT session_id) FILTER (WHERE user_id IS NULL)::int AS anon_sessions
        FROM win
    ),
    screens AS (
      SELECT json_agg(x) AS j FROM (
        SELECT name, COUNT(*)::int AS count FROM win WHERE type = 'screen'
         GROUP BY name ORDER BY count DESC, name LIMIT 15) x
    ),
    actions AS (
      SELECT json_agg(x) AS j FROM (
        SELECT name, COUNT(*)::int AS count FROM win WHERE type = 'action'
         GROUP BY name ORDER BY count DESC, name LIMIT 15) x
    ),
    errors AS (
      SELECT json_agg(x) AS j FROM (
        SELECT name, COUNT(*)::int AS count FROM win WHERE type = 'error'
         GROUP BY name ORDER BY count DESC, name LIMIT 15) x
    ),
    err_trend AS (
      SELECT json_agg(x) AS j FROM (
        SELECT to_char(date_trunc('day', received_at), 'YYYY-MM-DD') AS day,
               COUNT(*)::int AS count
          FROM win WHERE type = 'error'
         GROUP BY 1) x
    ),
    by_user AS (
      SELECT json_agg(x) AS j FROM (
        SELECT w.user_id::text AS "userId",
               COALESCE(u.name, 'Unknown') AS name,
               COALESCE(u.role::text, '—') AS role,
               COUNT(*)::int AS count
          FROM win w JOIN users u ON u.id = w.user_id
         WHERE w.user_id IS NOT NULL
         GROUP BY w.user_id, u.name, u.role
         ORDER BY count DESC, name LIMIT 10) x
    ),
    by_role AS (
      SELECT json_agg(x) AS j FROM (
        SELECT u.role::text AS name, COUNT(*)::int AS count
          FROM win w JOIN users u ON u.id = w.user_id
         GROUP BY u.role ORDER BY count DESC, name LIMIT 10) x
    ),
    by_team AS (
      SELECT json_agg(x) AS j FROM (
        SELECT t.name AS name, COUNT(*)::int AS count
          FROM win w
          JOIN team_members tm ON tm.user_id = w.user_id
          JOIN teams t ON t.id = tm.team_id
         GROUP BY t.name ORDER BY count DESC, name LIMIT 10) x
    ),
    plat AS (
      SELECT json_agg(x) AS j FROM (
        SELECT COALESCE(platform, 'unknown') AS platform, COUNT(*)::int AS count
          FROM win GROUP BY platform ORDER BY count DESC LIMIT 10) x
    ),
    ver AS (
      SELECT json_agg(x) AS j FROM (
        SELECT COALESCE(app_version, 'unknown') AS version, COUNT(*)::int AS count
          FROM win GROUP BY app_version ORDER BY count DESC LIMIT 10) x
    )
    SELECT (SELECT row_to_json(totals) FROM totals) AS totals,
           (SELECT j FROM screens)   AS screens,
           (SELECT j FROM actions)   AS actions,
           (SELECT j FROM errors)    AS errors,
           (SELECT j FROM err_trend) AS err_trend,
           (SELECT j FROM by_user)   AS by_user,
           (SELECT j FROM by_role)   AS by_role,
           (SELECT j FROM by_team)   AS by_team,
           (SELECT j FROM plat)      AS platforms,
           (SELECT j FROM ver)       AS versions`;

  const res = await pg.query(sql, [days]);
  return shapeTelemetrySummary(res.rows[0] ?? {}, days);
}

export function sanitizeEvent(raw: any): CleanEvent | null {
  if (!raw || typeof raw.type !== 'string' || !TYPES.has(raw.type)) return null;
  if (typeof raw.name !== 'string' || !raw.name) return null;
  const name = sanitizeLabel(raw.name);
  if (!name) return null;
  const props: Record<string, unknown> = {};
  if (raw.props && typeof raw.props === 'object') {
    for (const k of Object.keys(raw.props)) {
      if (!TELEMETRY_PROP_ALLOWLIST.has(k)) continue;
      const v = raw.props[k];
      if (typeof v === 'string') props[k] = v.slice(0, 200);
      else if (typeof v === 'number' || typeof v === 'boolean') props[k] = v;
    }
  }
  return {
    type: raw.type,
    name,
    screen: typeof raw.screen === 'string' ? sanitizeLabel(raw.screen) : null,
    props,
    client_ts: typeof raw.client_ts === 'string' ? raw.client_ts.slice(0, 40) : null,
  };
}
