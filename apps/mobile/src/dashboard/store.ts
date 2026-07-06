import { useSyncExternalStore } from 'react';
import type { UserSession } from '../auth/permissions';
import { DEFAULT_LAYOUT, type Layout } from './widgets';
import { resolveLayout } from './resolve';
import {
  getDashboardPresets,
  getRoleDashboardPresetIds,
  getUserDashboardPresetId,
  type DashboardPreset,
} from '../db/queries/dashboards';

// Re-export the pure resolver/parse helpers (defined DB-free in ./resolve so they
// stay unit-testable) for callers that import them from the store.
export { resolveLayout, parsePresetLayout } from './resolve';

// Reactive cache of dashboard presets + role assignments, mirroring the
// role-permission cache in src/auth/permissions.ts. Populated by
// loadDashboardCache() at boot and after each sync so the hub re-resolves without a
// remount. KEEP synced config that GATES/SHAPES the UI reactive — a preset edit or
// assignment lands after a pull and must show immediately.
let presetsById: Record<string, DashboardPreset> = {};
let rolePresetIds: Record<string, string | null> = {};

let cacheVersion = 0;
const listeners = new Set<() => void>();

export function subscribeDashboard(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getDashboardVersion(): number {
  return cacheVersion;
}

// Refresh the preset + role-assignment caches from the local DB. Safe to call
// before the DB is ready (or before migration 033) — failures leave the existing
// cache in place. Always bumps the version + notifies so the hub re-resolves.
export function loadDashboardCache(): void {
  try {
    const presets = getDashboardPresets();
    const byId: Record<string, DashboardPreset> = {};
    for (const p of presets) byId[p.id] = p;
    presetsById = byId;
    rolePresetIds = getRoleDashboardPresetIds();
  } catch {
    // DB not initialized / column missing — keep whatever we have.
  }
  cacheVersion++;
  listeners.forEach(l => l());
}

// Resolve the effective layout for a user: users.dashboard_preset_id →
// role_settings[role].dashboard_preset_id → DEFAULT_LAYOUT. Reads the caller's own
// preset id from the DB (cheap single-row) and the role assignment from cache; any
// failure resolves to DEFAULT_LAYOUT so the hub always renders.
export function resolveLayoutFor(user: UserSession): Layout {
  try {
    const userPresetId = getUserDashboardPresetId(user.id);
    const rolePresetId = rolePresetIds[user.role] ?? null;
    return resolveLayout(userPresetId, rolePresetId, presetsById);
  } catch {
    return DEFAULT_LAYOUT;
  }
}

// Hook: re-renders when the dashboard cache changes (preset edit / sync / assignment)
// via useSyncExternalStore, then resolves the caller's layout. Mirrors usePermission.
export function useDashboardLayout(user: UserSession | null): Layout {
  useSyncExternalStore(subscribeDashboard, getDashboardVersion, getDashboardVersion);
  if (!user) return DEFAULT_LAYOUT;
  return resolveLayoutFor(user);
}
