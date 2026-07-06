import type { SqlDb } from '../types';

// Migration 030: sub-area (child location) types. Mirrors API migration 036.
// A location with a PARENT is a sub-area; its type picker offers these SUB-AREA
// types (Closet, Section, Storage, Shelf, Area, Bin, Rack) instead of the
// top-level location_type list. Managed in Manage Types as category
// 'location_subtype'.
//
// Seeded here with the SAME fixed UUIDs as API migration 036 so the feature is
// testable on-device BEFORE the API deploys, and both sides converge on sync
// (same primary key → no duplicate rows). INSERT OR IGNORE so a later synced
// server row can INSERT-OR-REPLACE over it, and re-running is a no-op.
const ROWS: [id: string, label: string, icon: string, sort_order: number][] = [
  ['f5b0a5e0-0000-4000-8000-000000000001', 'Closet', '🚪', 0],
  ['f5b0a5e0-0000-4000-8000-000000000002', 'Section', '🗂️', 1],
  ['f5b0a5e0-0000-4000-8000-000000000003', 'Storage', '📦', 2],
  ['f5b0a5e0-0000-4000-8000-000000000004', 'Shelf', '🗄️', 3],
  ['f5b0a5e0-0000-4000-8000-000000000005', 'Area', '📍', 4],
  ['f5b0a5e0-0000-4000-8000-000000000006', 'Bin', '🧺', 5],
  ['f5b0a5e0-0000-4000-8000-000000000007', 'Rack', '🗃️', 6],
];

export const migration = {
  version: 30,
  up: (db: SqlDb): void => {
    for (const [id, label, icon, sort_order] of ROWS) {
      db.executeSync(
        `INSERT OR IGNORE INTO taxonomy_types (id, category, label, icon, sort_order, active, updated_at) VALUES (?, 'location_subtype', ?, ?, ?, 1, '2026-07-05T00:00:00.000Z')`,
        [id, label, icon, sort_order],
      );
    }
  },
};
