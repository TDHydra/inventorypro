// Node-only stand-in for db/queries/dashboards, swapped in by
// dashboard/dashboardCacheRefresh.test.ts via a module-hook redirect (the real
// module imports db/schema -> op-sqlite, a native binding that can't load
// under `node --test`). Plain in-memory maps instead of a real DB — store.ts's
// loadDashboardCache()/resolveLayoutFor() only need the same function
// surface, not real SQL. Mirrors the real module's shape (id → DashboardPreset,
// role → presetId) closely enough that a call sequence exercised against this
// fake is a faithful reproduction of the real cache-staleness bug (#192).
import type { Layout } from '../../dashboard/widgets';
import type { DashboardPreset } from './dashboards';

let presets: Record<string, DashboardPreset> = {};
let rolePresetIds: Record<string, string | null> = {};

/** Test-only: wipe all state between tests. */
export function __reset(): void {
  presets = {};
  rolePresetIds = {};
}

/** Test-only: seed a preset row directly (bypassing create/rename plumbing). */
export function __seedPreset(p: DashboardPreset): void {
  presets[p.id] = p;
}

/** Test-only: seed a role → preset assignment directly. */
export function __seedRolePreset(role: string, presetId: string | null): void {
  rolePresetIds[role] = presetId;
}

export function getDashboardPresets(): DashboardPreset[] {
  return Object.values(presets).sort((a, b) => a.name.localeCompare(b.name));
}

export function getDashboardPresetById(id: string): DashboardPreset | null {
  return presets[id] ?? null;
}

export function getRoleDashboardPresetIds(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [role, id] of Object.entries(rolePresetIds)) {
    if (id) out[role] = id;
  }
  return out;
}

export function getUserDashboardPresetId(_userId: string): string | null {
  return null;
}

// Mirrors the real setDashboardPresetLayout: this is the write dashboards.tsx's
// persist() (and handleDuplicate/handleStartFromRole) issues on every preset
// mutation. presetsById is a SEPARATE cache in store.ts populated only by
// loadDashboardCache() — calling this alone must NOT make resolveLayoutFor see
// the new layout; that's the point of the regression test using this fake.
export function setDashboardPresetLayout(id: string, layout: Layout): void {
  const existing = presets[id];
  if (!existing) return;
  presets[id] = { ...existing, layout: JSON.stringify(layout), updated_at: new Date().toISOString() };
}
