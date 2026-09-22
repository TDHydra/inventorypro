// Post-login full database download. Runs AFTER a successful PIN sign-in (the
// device now holds a JWT), so /sync/full is called WITH the bearer token — the
// endpoint is authenticated server-side and refuses anonymous dumps.
//
// Manifest-driven: the table order that used to be the hand-synced SYNC_TABLES
// list derives from the manifest (FULL_DOWNLOAD_TABLES — role_settings + users
// first so permissions resolve; parity with the old list is proven by
// ../manifest/parity.test.ts). Every table now goes through the ONE generic
// column-intersection upsert — the old file's bespoke per-table arms
// (upsertItem/upsertStock/…) were domain-layer duplicates of the same insert.
import { getDb, bindParams } from '../db/provider';
import { apiBase } from '../config';
import { FULL_DOWNLOAD_TABLES } from '../manifest/derive';

export const FULL_DOWNLOAD_TABLE_COUNT = FULL_DOWNLOAD_TABLES.length;

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
 *
 * The old app also pinned the media thumbnail-prefetch watermark at the end of
 * this function; that is domain logic and now the CALLER's job, immediately
 * after this resolves (otherwise the sync engine tries to warm every thumbnail
 * ever uploaded on first launch).
 */
export async function runFullDownload(
  jwt: string,
  onProgress: (p: DownloadProgress) => void,
): Promise<void> {
  const db = getDb();

  // Suspend local FK enforcement for the bulk restore. /sync/full pages every
  // table ORDER BY id, so rows arrive in uuid order, not dependency order: a
  // location whose parent's uuid sorts after its own is INSERTed before that
  // parent exists (locations.parent_id is self-referencing), and SQLite's
  // immediate FK check then fails the entire first-launch download. Scoped
  // tables can also legitimately reference rows the server never sends this
  // caller. The server owns FK integrity for all of this data — re-checking it
  // row-by-row here only breaks enrollment.
  db.executeSync(`PRAGMA foreign_keys = OFF`);
  try {
    for (let i = 0; i < FULL_DOWNLOAD_TABLES.length; i++) {
      const table = FULL_DOWNLOAD_TABLES[i];
      onProgress({ table, step: i + 1, total: FULL_DOWNLOAD_TABLES.length });

      let page = 0;
      let hasMore = true;

      while (hasMore) {
        const res = await fetch(
          `${apiBase()}/sync/full?table=${table}&page=${page}&limit=500`,
          { headers: { Authorization: `Bearer ${jwt}` } },
        );
        if (res.status === 401 || res.status === 403) throw new SessionExpiredError();
        if (!res.ok) throw new Error(`Failed to download ${table}: ${res.status}`);

        const data = (await res.json()) as { rows: unknown[]; hasMore: boolean };
        applyRows(table, data.rows as Record<string, unknown>[]);
        hasMore = data.hasMore;
        page++;
      }
    }
  } finally {
    // Always restore — a failed download is retried, and every write after this
    // point (including the user's own edits) must be FK-checked as normal.
    db.executeSync(`PRAGMA foreign_keys = ON`);
  }
}

function applyRows(table: string, rows: Record<string, unknown>[]): void {
  if (rows.length === 0) return;
  const db = getDb();

  // Name columns explicitly from the row keys, intersected with the LOCAL
  // column set (resolved once per page): the server can be migrations ahead of
  // this bundle (web deploys and field APKs lag the API), so any server column
  // the local table doesn't have yet must be dropped, not INSERTed — otherwise
  // first-launch dies on the unknown column. bindParams sanitizes JSONB
  // objects / booleans for the SQLite driver.
  const localCols = new Set(
    (db.executeSync(`PRAGMA table_info(${table})`).rows as { name: string }[]).map(r => r.name),
  );
  for (const row of rows) {
    const cols = Object.keys(row).filter(c => localCols.has(c));
    if (cols.length === 0) continue;
    db.executeSync(
      `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      bindParams(cols.map(c => row[c])),
    );
  }
}
