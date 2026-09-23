// Pure logic for the #23 "old-APK stragglers" report (apps/api/scripts/
// stragglers-report.ts). Separated from the script so it's unit-testable
// without a DB — mirrors the audit.ts/telemetry.ts split (route/script does
// I/O, this file does shaping).
//
// The report answers: for each device_id seen in telemetry_events or
// api_request_audit (the only two tables that carry app_version — neither
// /sync/pull nor /sync/push does, and that's intentional, see #23), what's
// the latest app version it reported, who used it, when was it last seen,
// and is that version behind the current release.

/** One raw sighting of a device, from either telemetry_events or api_request_audit. */
export interface RawDeviceEvent {
  deviceId: string;
  userId: string | null;
  appVersion: string | null;
  /** ISO-8601 timestamp (received_at / occurred_at). */
  ts: string;
}

export interface DeviceSummary {
  deviceId: string;
  /** Latest non-null app_version seen for this device, or 'unknown' if it never sent one. */
  latestVersion: string;
  /** Most recent ts across ALL sightings, regardless of whether that sighting carried a version. */
  lastSeen: string;
  /** Distinct non-null user_ids seen on this device, sorted. */
  userIds: string[];
  /** True when latestVersion is older than the current release, or unknown. */
  behind: boolean;
}

/**
 * Numeric segment semver-ish compare (major.minor.patch...). No pre-release/
 * build-metadata handling — this codebase's app.json versions are plain
 * numeric triples, and a full semver parser would be a dependency for no gain.
 * Missing/non-numeric segments compare as 0. Returns <0, 0, >0 like a normal
 * comparator (a<b, a==b, a>b).
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(s => parseInt(s, 10) || 0);
  const pb = b.split('.').map(s => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/**
 * Merge raw sightings (union of both tables, in any order) down to one row
 * per device_id: the latest-seen app_version (ignoring sightings that didn't
 * carry one), the overall last-seen timestamp, and the distinct set of users.
 * Pure reduction — no DB, no dedup between the two source tables needed
 * beyond grouping by device_id (a device seen in both just contributes rows
 * from both into the same group).
 */
export function reduceDeviceRows(rows: RawDeviceEvent[]): DeviceSummary[] {
  const byDevice = new Map<string, RawDeviceEvent[]>();
  for (const r of rows) {
    if (!r.deviceId) continue;
    const list = byDevice.get(r.deviceId);
    if (list) list.push(r);
    else byDevice.set(r.deviceId, [r]);
  }

  const out: DeviceSummary[] = [];
  for (const [deviceId, evs] of byDevice) {
    let lastSeen = evs[0].ts;
    let latestVersion: string | null = null;
    let latestVersionTs = '';
    const userIds = new Set<string>();
    for (const e of evs) {
      if (e.ts > lastSeen) lastSeen = e.ts;
      if (e.userId) userIds.add(e.userId);
      if (e.appVersion && e.ts > latestVersionTs) {
        latestVersionTs = e.ts;
        latestVersion = e.appVersion;
      }
    }
    out.push({
      deviceId,
      latestVersion: latestVersion ?? 'unknown',
      lastSeen,
      userIds: [...userIds].sort(),
      behind: false, // filled in by markBehind once currentVersion is known
    });
  }
  return out;
}

/**
 * Stamp `behind` on each device relative to currentVersion. A device that
 * never reported a version ('unknown') counts as behind — it's the case we
 * most want to surface, since it means we can't even confirm it's current.
 */
export function markBehind(devices: DeviceSummary[], currentVersion: string): DeviceSummary[] {
  return devices.map(d => ({
    ...d,
    behind: d.latestVersion === 'unknown' ? true : compareVersions(d.latestVersion, currentVersion) < 0,
  }));
}

/**
 * Sort stragglers to the top: behind devices first (unknown-version devices
 * first among those, then oldest reported version), current devices after —
 * within each group, most-recently-seen first so the report reads as
 * "most actionable first."
 */
export function sortStragglers(devices: DeviceSummary[]): DeviceSummary[] {
  return [...devices].sort((a, b) => {
    if (a.behind !== b.behind) return a.behind ? -1 : 1;
    if (a.behind) {
      const aUnknown = a.latestVersion === 'unknown';
      const bUnknown = b.latestVersion === 'unknown';
      if (aUnknown !== bUnknown) return aUnknown ? -1 : 1;
      if (!aUnknown && a.latestVersion !== b.latestVersion) {
        return compareVersions(a.latestVersion, b.latestVersion);
      }
    }
    if (a.lastSeen !== b.lastSeen) return a.lastSeen < b.lastSeen ? 1 : -1;
    return a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0;
  });
}

export interface ReportRow {
  deviceId: string;
  version: string;
  status: 'BEHIND' | 'UNKNOWN' | 'CURRENT';
  lastSeen: string;
  users: string;
}

/** Shape DeviceSummary rows for display, resolving user ids via the given lookup. */
export function toReportRows(devices: DeviceSummary[], userDisplay: (id: string) => string): ReportRow[] {
  return devices.map(d => ({
    deviceId: d.deviceId,
    version: d.latestVersion,
    status: d.latestVersion === 'unknown' ? 'UNKNOWN' : d.behind ? 'BEHIND' : 'CURRENT',
    lastSeen: d.lastSeen,
    users: d.userIds.length ? d.userIds.map(userDisplay).join(', ') : '—',
  }));
}

const COLUMNS = ['DEVICE ID', 'VERSION', 'STATUS', 'LAST SEEN', 'USERS'] as const;

/** Plain-text table, space-padded columns, no dependency (no cli-table/etc). */
export function formatTable(rows: ReportRow[]): string {
  const cells = rows.map(r => [r.deviceId, r.version, r.status, r.lastSeen, r.users]);
  const widths = COLUMNS.map((h, i) =>
    Math.max(h.length, ...cells.map(c => c[i].length), 0));
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
  const line = (vals: string[]) => vals.map((v, i) => pad(v, widths[i])).join('  ');

  const lines = [line([...COLUMNS]), widths.map(w => '-'.repeat(w)).join('  ')];
  for (const c of cells) lines.push(line(c));
  return lines.join('\n');
}

/** One-line "N of M devices behind" summary. */
export function summaryLine(devices: DeviceSummary[]): string {
  const behind = devices.filter(d => d.behind).length;
  return `${behind} of ${devices.length} device${devices.length === 1 ? '' : 's'} behind`;
}
