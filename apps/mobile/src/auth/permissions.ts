import { UserRole, Permission, ROLE_DEFAULTS } from '../constants/roles';
import { getRolePermissionOverrides } from '../db/queries/users';

export type { Permission } from '../constants/roles';

// Module-level cache of per-role permission deviations from ROLE_DEFAULTS, keyed
// by role. Populated by loadRolePermissionCache() at boot and after each sync, so
// hasPermission() can stay synchronous (unchanged signature) instead of hitting
// the DB on every call.
let roleOverridesCache: Record<string, Record<string, boolean>> = {};

// Refresh roleOverridesCache from role_settings. Safe to call before the DB is
// ready (or before migration 014) — failures leave the existing cache in place.
export function loadRolePermissionCache(): void {
  try {
    roleOverridesCache = getRolePermissionOverrides();
  } catch {
    // DB not initialized / column missing — keep whatever we have.
  }
}

// Self-lockout floor: full_admin ALWAYS retains these regardless of any
// role/user override, so the system can never lose permission management.
// Authoritative (not just UI-disabled). KEEP IN SYNC with apps/api/src/lib/permissions.ts.
const FULL_ADMIN_FLOOR: Permission[] = ['manage_roles_permissions', 'system_settings'];

export interface TeamContext {
  team_id: string;
  team_permission_overrides: Record<string, boolean>;
}

export interface UserSession {
  id: string;
  name: string;
  role: UserRole;
  permission_overrides: Record<string, boolean>;
  pin_length_required: number;
  active: number;
  expires_at: string | null;
  team_contexts?: TeamContext[];
}

/**
 * Resolve whether a user has a given permission.
 *
 * Resolution order (last match wins):
 * 1. Role default
 * 2. Role-level override (runtime, synced via role_settings)
 * 3. Team override (if teamId provided — set by dept manager, scoped to team)
 * 4. Global user override (set by Admin/HR — always wins)
 */
export function hasPermission(
  user: UserSession,
  permission: Permission,
  teamId?: string | null
): boolean {
  // 0. Self-lockout floor — full_admin can never lose these (overrides ignored).
  if (user.role === 'full_admin' && FULL_ADMIN_FLOOR.includes(permission)) return true;

  // 1. Role default
  let result = ROLE_DEFAULTS[user.role]?.[permission] ?? false;

  // 1b. Role-level override (runtime deviation from ROLE_DEFAULTS)
  const roleOv = roleOverridesCache[user.role];
  if (roleOv && permission in roleOv) {
    result = roleOv[permission];
  }

  // 2. Team-level override (only if a team context is active)
  if (teamId && user.team_contexts) {
    const teamCtx = user.team_contexts.find(t => t.team_id === teamId);
    if (teamCtx && permission in teamCtx.team_permission_overrides) {
      result = teamCtx.team_permission_overrides[permission];
    }
  }

  // 3. Global user override (always wins)
  if (permission in user.permission_overrides) {
    result = user.permission_overrides[permission];
  }

  return result;
}

/**
 * Check if a user can grant a specific permission to another user/team member.
 * A manager can only grant permissions they themselves hold.
 */
export function canGrant(
  granter: UserSession,
  permission: Permission,
  teamId?: string | null
): boolean {
  return hasPermission(granter, permission, teamId);
}

export function parsePermissionOverrides(raw: string): Record<string, boolean> {
  try {
    return JSON.parse(raw) as Record<string, boolean>;
  } catch {
    return {};
  }
}
