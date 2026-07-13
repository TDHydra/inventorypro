// Post-login full database download. Runs AFTER a successful PIN sign-in (the
// device now holds a JWT), so /sync/full is called WITH the bearer token — the
// endpoint is authenticated server-side and refuses anonymous dumps. The login
// picker itself uses the minimal public /auth/roster; everything here (full user
// rows incl. permission_overrides, plus all business data) requires the token.

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

// Order matters: role_settings + users first so permissions resolve, then the
// business tables. Mirrors the server's FULL_TABLES allowlist.
const SYNC_TABLES = [
  'role_settings', 'users', 'locations', 'inventory_items',
  'stock_by_location', 'jobs', 'teams', 'team_members', 'media',
  // Operational tables that were previously only backfilled via incremental
  // /sync/pull — added so a fresh device has full state after enrollment.
  'equipment_units', 'app_config', 'taxonomy_types', 'repairs', 'repair_parts',
  'maintenance_events', 'label_templates', 'dashboard_presets',
  // notifications is SCOPED_TABLES (server returns only the caller's own rows);
  // approval_requests is unscoped but /sync/pull already returns all rows to
  // every user, so a full backfill is consistent (no new exposure).
  'notifications', 'approval_requests',
  // chat: SCOPED server-side to the caller's own conversations (see sync.ts
  // chatScopeSql) — a fresh device gets only the conversations it participates in.
  'conversations', 'conversation_participants', 'messages',
] as const;

export const FULL_DOWNLOAD_TABLE_COUNT = SYNC_TABLES.length;

export interface DownloadProgress {
  table: string;
  step: number;
  total: number;
}

/** Thrown when the server rejects the token mid-download (expired/invalid). */
export class SessionExpiredError extends Error {
  constructor() {
    super('Your session expired during setup. Please sign in again.');
    this.name = 'SessionExpiredError';
  }
}

/**
 * Downloads every synced table into the local DB, paging 500 rows at a time.
 * Throws on the first failure (caller shows the error + a retry). `jwt` must be
 * a valid access token; a 401 surfaces as SessionExpiredError so the caller can
 * bounce back to the login screen rather than showing a generic failure.
 */
export async function runFullDownload(
  jwt: string,
  onProgress: (p: DownloadProgress) => void,
): Promise<void> {
  for (let i = 0; i < SYNC_TABLES.length; i++) {
    const table = SYNC_TABLES[i];
    onProgress({ table, step: i + 1, total: SYNC_TABLES.length });

    let page = 0;
    let hasMore = true;

    while (hasMore) {
      const res = await fetch(
        `${API_BASE}/sync/full?table=${table}&page=${page}&limit=500`,
        { headers: { Authorization: `Bearer ${jwt}` } },
      );
      if (res.status === 401 || res.status === 403) throw new SessionExpiredError();
      if (!res.ok) throw new Error(`Failed to download ${table}: ${res.status}`);

      const data = (await res.json()) as { rows: unknown[]; hasMore: boolean };
      await applyRows(table, data.rows);
      hasMore = data.hasMore;
      page++;
    }
  }
}

async function applyRows(table: string, rows: unknown[]): Promise<void> {
  // Dynamic imports avoid a circular dependency (queries import the sync layer).
  const { upsertItem, upsertStock } = await import('../db/queries/items');
  const { upsertLocation } = await import('../db/queries/locations');
  const { upsertUser } = await import('../db/queries/users');
  const { upsertJob } = await import('../db/queries/jobs');
  const { upsertUnit } = await import('../db/queries/equipmentUnits');

  const schema = await import('../db/schema');
  const db = schema.getDb();

  // Local column set for the generic arm, resolved once per page. The server
  // can be migrations ahead of this bundle (web deploys and field APKs lag the
  // API), so any server column the local table doesn't have yet must be
  // dropped, not INSERTed — otherwise first-launch dies on the unknown column.
  let localCols: Set<string> | null = null;

  for (const row of rows as Record<string, unknown>[]) {
    switch (table) {
      case 'inventory_items': upsertItem(row as any); break;
      case 'stock_by_location': upsertStock(row as any, row.location_id as string, row.quantity as number); break;
      case 'locations': upsertLocation(row as any); break;
      case 'users': upsertUser(row as any); break;
      case 'jobs': upsertJob(row as any); break;
      case 'equipment_units': upsertUnit(row as any); break;
      case 'role_settings':
      case 'teams':
      case 'team_members':
      case 'media':
      // Plain TEXT/REAL tables with no bespoke upsert logic — the generic arm
      // names columns from the row keys, so it tolerates the server omitting
      // local-only (synced_at) or financial (cost/purchase_price) columns.
      case 'app_config':
      case 'taxonomy_types':
      case 'repairs':
      case 'repair_parts':
      case 'maintenance_events':
      case 'label_templates':
      case 'dashboard_presets':
      case 'notifications':
      case 'approval_requests':
      case 'conversations':
      case 'conversation_participants':
      case 'messages': {
        // Generic upsert — name columns explicitly from the row keys so we
        // tolerate column-count/order differences (e.g. server omits synced_at)
        // and sanitize values (JSONB objects / booleans) for op-sqlite.
        if (!localCols) {
          localCols = new Set(
            (db.executeSync(`PRAGMA table_info(${table})`).rows as { name: string }[]).map(r => r.name),
          );
        }
        const known = localCols;
        const cols = Object.keys(row).filter(c => known.has(c));
        if (cols.length === 0) break;
        db.executeSync(
          `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
          schema.bindParams(cols.map(c => row[c])),
        );
        break;
      }
    }
  }
}
