import type { SqlDb } from '../types';

// Migration 062: split dashboard_prefs into per-field columns (#193/#196
// follow-up). Mirrors API migration 076.
//
// dashboard_prefs (migration 060) multiplexed BOTH the personal layout
// override and the starred-widget set into one JSON blob, so EVERY setter
// (setDashboardLayout/setStarredWidgets in db/userPrefs.ts) had to read the
// local blob, merge in its one field, and overwrite the WHOLE column — with
// no version check. A device whose local replica was stale (hadn't pulled a
// sync from another device yet) would silently clobber the other device's
// already-synced field on its next write (Device B saving a layout erased
// Device A's already-synced stars). Splitting into dashboard_layout and
// starred_widgets lets the existing column-scoped server upsert (ON CONFLICT
// DO UPDATE SET <only the columns present in the payload> — routes/sync.ts)
// protect each field independently, the same mechanism that already protects
// the theme column from a dashboard-prefs write and vice versa.
//
// dashboard_prefs is left in place (dead) — NOT dropped. sql.js/web ALTER
// DROP COLUMN is risky (see docs/SYNC-MIGRATION-CHECKLIST.md precedent), and
// the column stays synced (pull.ts/fullDownload.ts still carry it) purely as
// a forensic/rollback safety net; nothing reads it going forward except the
// one-time backfill below and userPrefs.ts's legacy-blob fallback for a row
// that was pulled before this migration ran (new columns still NULL).
//
// Backfill: parse each existing row's dashboard_prefs blob and populate the
// two new columns from it, so no existing customization is lost on upgrade.
// Invalid/empty/missing sub-fields are left NULL (same "nobody customized
// yet" default 060 used) rather than writing an empty array — an empty array
// and NULL both read as "no override" (dashboard/store.ts's ?? []), so this
// keeps the two representations from diverging.
export const migration = {
  version: 62,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE user_prefs ADD COLUMN dashboard_layout TEXT`);
    db.executeSync(`ALTER TABLE user_prefs ADD COLUMN starred_widgets TEXT`);

    const rows = db.executeSync(
      `SELECT user_id, dashboard_prefs FROM user_prefs WHERE dashboard_prefs IS NOT NULL`
    ).rows as { user_id: string; dashboard_prefs: string }[];

    for (const row of rows) {
      let parsed: { layout?: unknown; starred?: unknown } | null = null;
      try {
        const p: unknown = JSON.parse(row.dashboard_prefs);
        parsed = p && typeof p === 'object' ? (p as { layout?: unknown; starred?: unknown }) : null;
      } catch {
        parsed = null;
      }
      if (!parsed) continue;

      const layout = Array.isArray(parsed.layout) && parsed.layout.length > 0
        ? JSON.stringify(parsed.layout) : null;
      const starred = Array.isArray(parsed.starred) && parsed.starred.length > 0
        ? JSON.stringify(parsed.starred) : null;
      if (layout === null && starred === null) continue;

      db.executeSync(
        `UPDATE user_prefs SET dashboard_layout = ?, starred_widgets = ? WHERE user_id = ?`,
        [layout, starred, row.user_id]
      );
    }
  },
};
