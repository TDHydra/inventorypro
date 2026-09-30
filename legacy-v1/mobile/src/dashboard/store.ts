import { useSyncExternalStore } from 'react';
import type { UserSession } from '../auth/permissions';
import { DEFAULT_LAYOUT, type Layout } from './widgets';
import { parseStarKey } from './starKeys';
import { ROLE_DEFAULT_LAYOUTS } from './roleLayouts';
import { resolveLayout, parsePresetLayout } from './resolve';
import {
  getDashboardPresets,
  getRoleDashboardPresetIds,
  getUserDashboardPresetId,
  type DashboardPreset,
} from '../db/queries/dashboards';
import { getDashboardPrefs } from '../db/userPrefs';

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

// Resolve the effective layout for a user (role dashboards §1, extended by
// #193): personal layout (dashboard_prefs.layout) → users.dashboard_preset_id →
// role_settings[role].dashboard_preset_id → ROLE_DEFAULT_LAYOUTS[role] →
// DEFAULT_LAYOUT. The personal layout is the NEW top precedence tier — an
// explicit per-user customization (EditMyDashboardSheet) always wins over the
// admin-curated user/role presets, but a missing/invalid/empty one falls
// through to the existing preset chain exactly as before (never skips past
// it). Deliberately validated here in the store, NOT in ./resolve.ts — resolve
// stays a pure, DB-free reproduction of the preset chain only; personal-layout
// reads are a DB access (like getUserDashboardPresetId below) that belongs in
// this reactive layer. Reused parsePresetLayout (not a new resolve.ts export)
// since dashboard_prefs.layout is a JS array once JSON.parsed — round-tripping
// it through the same validator a preset's raw layout column uses keeps the
// two personalization surfaces (presets vs. personal) sharing one code path.
// Reads the caller's own rows from the DB (cheap single-row lookups, same as
// getUserDashboardPresetId) and the role assignment from cache; any failure
// resolves to the role's code default (then DEFAULT_LAYOUT) so the hub always
// renders.
export function resolveLayoutFor(user: UserSession): Layout {
  const roleDefault = ROLE_DEFAULT_LAYOUTS[user.role] ?? null;
  try {
    const personalRaw = getDashboardPrefs(user.id)?.layout;
    const personal = personalRaw ? parsePresetLayout(JSON.stringify(personalRaw)) : null;
    if (personal) return personal;
    const userPresetId = getUserDashboardPresetId(user.id);
    const rolePresetId = rolePresetIds[user.role] ?? null;
    return resolveLayout(userPresetId, rolePresetId, presetsById, roleDefault);
  } catch {
    return roleDefault ?? DEFAULT_LAYOUT;
  }
}

// Hook: re-renders when the dashboard cache changes (preset edit / sync / assignment /
// personal layout edit) via useSyncExternalStore, then resolves the caller's layout.
// Mirrors usePermission.
export function useDashboardLayout(user: UserSession | null): Layout {
  useSyncExternalStore(subscribeDashboard, getDashboardVersion, getDashboardVersion);
  if (!user) return DEFAULT_LAYOUT;
  return resolveLayoutFor(user);
}

// The user's starred keys (#196, #226): plain WidgetType keys or composite
// `widget:source` keys, filtered through parseStarKey so a stale entry from a
// removed/renamed widget type is dropped rather than rendered broken (the
// source half is validated by the strip against its own source registry).
// Any failure (DB not ready / bad JSON, already handled inside
// getDashboardPrefs) resolves to no stars — the strip just doesn't render.
export function getStarredWidgets(userId: string): string[] {
  try {
    return (getDashboardPrefs(userId)?.starred ?? []).filter(k => parseStarKey(k) !== null);
  } catch {
    return [];
  }
}

// Hook: re-renders on the SAME cache signal as useDashboardLayout (loadDashboardCache
// is called after a sync pull AND after the personal editor's star/layout writes — see
// db/userPrefs.ts), so the favorites strip updates without a remount either way.
export function useStarredWidgets(user: UserSession | null): string[] {
  useSyncExternalStore(subscribeDashboard, getDashboardVersion, getDashboardVersion);
  if (!user) return [];
  return getStarredWidgets(user.id);
}
