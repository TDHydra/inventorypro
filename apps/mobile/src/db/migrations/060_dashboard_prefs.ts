import type { SqlDb } from '../types';

// Migration 060: personal dashboard layout + starred favorites (#193, #196).
// Mirrors API migration 075. SYNCED column on the existing user_prefs table
// (docs/SYNC-MIGRATION-CHECKLIST.md — pull.ts TABLE_UPSERT_SQL/rowToValues and
// sync/fullDownload.ts extended in the same change; server projection in
// syncPolicy.ts too). user_prefs is already self-write-scoped (attribution
// pins user_id to the caller — see syncPolicy.ts ATTRIBUTION_COLUMNS), so no
// OPERATION_PERM/privileged-table change is needed for this column.
//
// dashboard_prefs is a single JSON TEXT blob (never an enum, never split into
// more columns) holding BOTH personal customizations so a device only ever
// needs one outbox write per edit:
//   { layout?: LayoutBlock[], starred?: WidgetType[] }
// - layout: the user's personal override of the dashboard resolution chain
//   (role dashboards §1) — resolved as the NEW top precedence tier ahead of
//   the user/role preset lookup in dashboard/store.ts's resolveLayoutFor().
//   Validated the same way a preset's `layout` column is (dashboard/resolve.ts
//   parsePresetLayout) — absent/invalid/empty falls through to the existing
//   preset chain, never crashes the hub.
// - starred: WidgetType ids the user pinned to the compact strip atop the
//   dashboard (#196). Filtered against isWidgetType() on read so a stale
//   entry from a removed widget type is dropped rather than rendered broken.
// NULL by default (nobody has customized yet) — no backfill, no watermark
// risk (existing rows keep whatever theme they had; this column just adds on).
export const migration = {
  version: 60,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE user_prefs ADD COLUMN dashboard_prefs TEXT`);
  },
};
