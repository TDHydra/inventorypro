/**
 * #23 "old-APK stragglers" report — read-only, standalone.
 *
 * The team-row leak itself is already fixed (server-side scoping in sync.ts +
 * client teamPurge). What's left is VISIBILITY: which devices/users are still
 * running an app version old enough to predate that fix, and therefore still
 * carry stale rows. This script never mutates anything — no schema changes,
 * no new API routes — it just reads the two tables that already carry
 * app_version (telemetry_events, api_request_audit; see lib/telemetry.ts and
 * lib/audit.ts) and reports the union.
 *
 * Note: neither /sync/pull nor /sync/push records app_version, and that's
 * intentional — see the #23 residual scope. Don't add it there; this report
 * works off the two sinks that already have it.
 *
 * Usage (from apps/api, matching the db:migrate / db:seed connection idiom in
 * src/db/migrate.ts):
 *
 *   DATABASE_URL=postgres://user:pass@host:5432/db npx tsx scripts/stragglers-report.ts
 *   DATABASE_URL=... npx tsx scripts/stragglers-report.ts --current=1.3.5
 *
 * --current overrides the "what's the latest release" baseline. Without it,
 * the script reads apps/mobile/app.json's expo.version at runtime.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import {
  type RawDeviceEvent,
  reduceDeviceRows, markBehind, sortStragglers, toReportRows, formatTable, summaryLine,
} from '../src/lib/stragglers';

function parseArgs(argv: string[]): { current?: string } {
  const out: { current?: string } = {};
  for (const arg of argv) {
    const m = /^--current=(.+)$/.exec(arg);
    if (m) out.current = m[1];
  }
  return out;
}

/** apps/mobile/app.json's expo.version, unless overridden by --current. */
function resolveCurrentVersion(flag?: string): string {
  if (flag) return flag;
  try {
    const appJsonPath = join(__dirname, '..', '..', 'mobile', 'app.json');
    const parsed = JSON.parse(readFileSync(appJsonPath, 'utf-8'));
    const version = parsed?.expo?.version;
    if (typeof version === 'string' && version) return version;
  } catch {
    // fall through to the error below — either the file's missing/unreadable
    // or unparsable; either way we refuse to guess a baseline.
  }
  throw new Error(
    'Could not read apps/mobile/app.json expo.version — pass --current=X.Y.Z explicitly.',
  );
}

/**
 * Every device_id sighting from the two tables that carry app_version. Plain
 * UNION ALL of raw rows — the merge/latest-per-device reduction happens in
 * JS (lib/stragglers.ts), not SQL, so it stays unit-testable without a DB.
 */
async function fetchRawEvents(client: Client): Promise<RawDeviceEvent[]> {
  const { rows } = await client.query(`
    SELECT device_id AS "deviceId", user_id AS "userId", app_version AS "appVersion",
           received_at AS ts
      FROM telemetry_events
     WHERE device_id IS NOT NULL
    UNION ALL
    SELECT device_id AS "deviceId", user_id AS "userId", app_version AS "appVersion",
           occurred_at AS ts
      FROM api_request_audit
     WHERE device_id IS NOT NULL
  `);
  return rows.map((r: { deviceId: string; userId: string | null; appVersion: string | null; ts: string | Date }) => ({
    deviceId: r.deviceId,
    userId: r.userId,
    appVersion: r.appVersion,
    ts: new Date(r.ts).toISOString(),
  }));
}

/** Best-effort id -> display name for the report's USERS column. */
async function fetchUserNames(client: Client, userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!userIds.length) return map;
  const { rows } = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM users WHERE id = ANY($1::uuid[])`,
    [userIds],
  );
  for (const r of rows) map.set(r.id, r.name);
  return map;
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const currentVersion = resolveCurrentVersion(args.current);

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL env var required');

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const raw = await fetchRawEvents(client);
    const merged = markBehind(reduceDeviceRows(raw), currentVersion);
    const sorted = sortStragglers(merged);

    const allUserIds = [...new Set(sorted.flatMap(d => d.userIds))];
    const nameMap = await fetchUserNames(client, allUserIds);
    const rows = toReportRows(sorted, id => nameMap.get(id) ?? id);

    console.log(`Current app version: ${currentVersion}`);
    console.log(`Devices (union of telemetry_events + api_request_audit): ${sorted.length}\n`);
    console.log(formatTable(rows));
    console.log('');
    console.log(summaryLine(sorted));
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('stragglers-report failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
