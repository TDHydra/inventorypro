import { UserRole, Permission, ROLE_DEFAULTS } from '../constants/roles';

export type { Permission } from '../constants/roles';

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
 * 2. Team override (if teamId provided — set by dept manager, scoped to team)
 * 3. Global user override (set by Admin/HR — always wins)
 */
export function hasPermission(
  user: UserSession,
  permission: Permission,
  teamId?: string | null
): boolean {
  // 1. Role default
  let result = ROLE_DEFAULTS[user.role]?.[permission] ?? false;

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
