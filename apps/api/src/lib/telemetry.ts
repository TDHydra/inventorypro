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
export interface TelemetrySummary {
  windowDays: number;
  totals: { events: number; sessions: number; users: number; devices: number; errors: number };
  topScreens: NameCount[];
  topActions: NameCount[];
  topErrors: NameCount[];
  byPlatform: { platform: string; count: number }[];
  byVersion: { version: string; count: number }[];
}

/**
 * Aggregate read model for the admin analytics screen (GET /telemetry/summary).
 * All counts are over the last `days` window (telemetry_events is pruned at 90d,
 * so callers clamp days to [1,90]). `days` is bound via make_interval — never
 * string-interpolated. Extracted from the route so it's unit-testable with a
 * mock pg. This is the ONLY read path into telemetry_events; it's gated on
 * system_settings at the route.
 */
export async function getTelemetrySummary(
  pg: { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> },
  days: number,
): Promise<TelemetrySummary> {
  const win = `received_at > NOW() - make_interval(days => $1)`;
  const top = (type: string) =>
    `SELECT name, COUNT(*)::int AS count FROM telemetry_events
       WHERE type = '${type}' AND ${win} GROUP BY name ORDER BY count DESC LIMIT 15`;

  const totalsQ = await pg.query(
    `SELECT COUNT(*)::int AS events,
            COUNT(DISTINCT session_id)::int AS sessions,
            COUNT(DISTINCT user_id)::int AS users,
            COUNT(DISTINCT device_id)::int AS devices,
            COUNT(*) FILTER (WHERE type = 'error')::int AS errors
       FROM telemetry_events WHERE ${win}`, [days]);
  const screensQ = await pg.query(top('screen'), [days]);
  const actionsQ = await pg.query(top('action'), [days]);
  const errorsQ = await pg.query(top('error'), [days]);
  const platQ = await pg.query(
    `SELECT COALESCE(platform, 'unknown') AS platform, COUNT(*)::int AS count
       FROM telemetry_events WHERE ${win} GROUP BY platform ORDER BY count DESC LIMIT 10`, [days]);
  const verQ = await pg.query(
    `SELECT COALESCE(app_version, 'unknown') AS version, COUNT(*)::int AS count
       FROM telemetry_events WHERE ${win} GROUP BY app_version ORDER BY count DESC LIMIT 10`, [days]);

  const t = totalsQ.rows[0] ?? {};
  return {
    windowDays: days,
    totals: {
      events: t.events ?? 0, sessions: t.sessions ?? 0, users: t.users ?? 0,
      devices: t.devices ?? 0, errors: t.errors ?? 0,
    },
    topScreens: screensQ.rows,
    topActions: actionsQ.rows,
    topErrors: errorsQ.rows,
    byPlatform: platQ.rows,
    byVersion: verQ.rows,
  };
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
