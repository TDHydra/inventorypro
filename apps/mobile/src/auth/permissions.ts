import { UserRole, Permission, ROLE_DEFAULTS, canActOnTarget } from '../constants/roles';
import { getRolePermissionOverrides } from '../db/queries/users';

export type { Permission } from '../constants/roles';

// Module-level cache of per-role permission deviations from ROLE_DEFAULTS, keyed
// by role. Populated by loadRolePermissionCache() at boot and after each sync, so
// hasPermission() can stay synchronous (unchanged signature) instead of hitting
// the DB on every call.
let roleOverridesCache: Record<string, Record<string, boolean>> = {};

// Reactivity: a version counter + listeners so usePermission (via
// useSyncExternalStore) re-renders when role overrides change. Without this the
// cache updates silently after a sync/edit but gated UI keeps showing stale
// permissions until the screen happens to remount — i.e. "role permission changes
// don't update". KEEP synced config that gates UI reactive, not just cached.
let cacheVersion = 0;
const listeners = new Set<() => void>();

export function subscribeRolePermissions(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getRolePermissionsVersion(): number {
  return cacheVersion;
}

// Refresh roleOverridesCache from role_settings. Safe to call before the DB is
// ready (or before migration 014) — failures leave the existing cache in place.
// Always bumps the version + notifies subscribers so the UI re-resolves.
export function loadRolePermissionCache(): void {
  try {
    roleOverridesCache = getRolePermissionOverrides();
  } catch {
    // DB not initialized / column missing — keep whatever we have.
  }
  cacheVersion++;
  listeners.forEach(l => l());
}

// Self-lockout floor: full_admin ALWAYS retains these regardless of any
// role/user override, so the system can never lose permission management.
// Authoritative (not just UI-disabled). KEEP IN SYNC with apps/api/src/lib/permissions.ts.
const FULL_ADMIN_FLOOR: Permission[] = ['manage_roles_permissions', 'system_settings'];

// Destructive permissions only a full_admin may grant/revoke. KEEP IN SYNC with
// FULL_ADMIN_ONLY_GRANT in apps/api/src/lib/permissions.ts.
const FULL_ADMIN_ONLY_GRANT: Permission[] = ['delete_inventory', 'delete_media'];

// Pre-flight editability of a single role→permission cell — the mobile mirror of
// canEditRolePermission in apps/api/src/lib/permissions.ts, applying the SAME three
// checks in the SAME order the server enforces on a role_settings write (#82), so
// the editor can disable-with-reason instead of failing on write and can't drift
// from the server. Holding manage_roles_permissions is a separate precondition to
// reach the editor and is intentionally not re-checked here.
export type PermissionEditability =
  | { editable: true; reason: null }
  | { editable: false; reason: string };

export function canEditRolePermission(
  callerRole: UserRole | null | undefined,
  targetRole: UserRole,
  perm: Permission,
): PermissionEditability {
  // 1. Tier guard — caller must be at/above the target role's effective tier.
  if (!callerRole || !canActOnTarget(callerRole, targetRole)) {
    return { editable: false, reason: 'This role is at or above your access level.' };
  }
  // 2. Self-lockout floor — full_admin can never lose these (forced ON).
  if (targetRole === 'full_admin' && FULL_ADMIN_FLOOR.includes(perm)) {
    return { editable: false, reason: 'Required for full admin.' };
  }
  // 3. Destructive grant — only a full_admin may grant/revoke delete permissions.
  if (FULL_ADMIN_ONLY_GRANT.includes(perm) && callerRole !== 'full_admin') {
    return { editable: false, reason: 'Only a full admin can grant this.' };
  }
  return { editable: true, reason: null };
}

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
  /** 1 = public demo account: sandboxed sync, 15-min idle cap, wiped at logout. */
  is_test?: number;
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
 * A ROLE's effective permission (default + role_settings override) — no user or
 * team layer. Drives the preset editor's widget filtering and the Teams sheet's
 * baseline values. Reactive via the same roleOverridesCache that
 * loadRolePermissionCache refreshes + notifies on.
 */
export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  if (role === 'full_admin' && FULL_ADMIN_FLOOR.includes(permission)) return true;
  let result = ROLE_DEFAULTS[role]?.[permission] ?? false;
  const ov = roleOverridesCache[role];
  if (ov && permission in ov) result = ov[permission];
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
